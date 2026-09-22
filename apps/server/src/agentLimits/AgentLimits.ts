import type {
  AgentLimitsSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderLimitSnapshot,
} from "@t3tools/contracts";
import {
  type AgentLimitState,
  type AgentLimitWindow,
  bindingWindow,
  EMPTY_LIMIT_STATE,
  limitLevel,
  mergeLimitState,
  parseClaudeRateLimitInfo,
  parseRateLimitsBlock,
} from "@t3tools/shared/agentLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

/**
 * How much of each provider subscription is left, and when it refills.
 *
 * Both Claude and Codex already announce their remaining headroom on the event
 * stream the provider adapters produce — Claude as a `rate_limit_event`, Codex
 * as `account/rateLimits/updated`. Nothing here polls or shells out; it folds
 * those announcements into a picture per provider instance and republishes it.
 *
 * The updates are sparse by design: an event names one window and says nothing
 * about the other, so state is merged rather than replaced.
 */
export class AgentLimits extends Context.Service<
  AgentLimits,
  {
    readonly latest: Effect.Effect<AgentLimitsSnapshot>;
    readonly changes: Stream.Stream<AgentLimitsSnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: AgentLimitsSnapshot;
        readonly changes: Stream.Stream<AgentLimitsSnapshot>;
      },
      never,
      Scope.Scope
    >;
    /**
     * Rows read from local tools rather than the event stream (claude-swap,
     * Codex session logs, the Cursor CLI), replacing the previous set from the
     * same `source` key.
     */
    readonly setPolled: (
      sourceKey: string,
      rows: ReadonlyArray<ProviderLimitSnapshot>,
    ) => Effect.Effect<void>;
  }
>()("t3/agentLimits/AgentLimits") {}

interface TrackedProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly state: AgentLimitState;
}

/**
 * Limits are metered per subscription, so an instance id is the right key.
 * Adapters that have not yet been migrated omit it, and then the driver name
 * stands in — two accounts on one driver merge, which is wrong but visible,
 * where dropping the reading entirely would be silent.
 */
function trackingKey(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId | undefined,
): string {
  return instanceId ?? driver;
}

export function toWindow(window: AgentLimitWindow | null): Option.Option<{
  readonly usedPercent: number;
  readonly resetsAt: Option.Option<DateTime.Utc>;
  readonly windowMinutes: Option.Option<number>;
}> {
  if (window === null) {
    return Option.none();
  }
  return Option.some({
    usedPercent: window.usedPercent,
    resetsAt:
      window.resetsAt === null
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(window.resetsAt * 1000)),
    windowMinutes:
      window.windowMinutes === null ? Option.none() : Option.some(Math.round(window.windowMinutes)),
  });
}

function toSnapshotRow(tracked: TrackedProvider): ProviderLimitSnapshot {
  const state = tracked.state;
  return {
    instanceId: tracked.instanceId,
    driver: tracked.driver,
    label: tracked.driver,
    short: toWindow(state.short),
    long: toWindow(state.long),
    binding: toWindow(bindingWindow(state)),
    level: limitLevel(state),
    source: state.source,
    observedAt:
      state.observedAt === null
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(state.observedAt * 1000)),
  } satisfies ProviderLimitSnapshot;
}

/**
 * Claude reports one window per event with a fractional utilization; everyone
 * else sends a Codex-shaped block naming both windows. The shapes do not
 * collide, so the driver only decides which reader is tried first.
 */
function readEvent(driver: string, rateLimits: unknown, observedAt: number): AgentLimitState {
  if (driver === "claude") {
    const claude = parseClaudeRateLimitInfo(rateLimits, observedAt);
    if (claude.source !== "unknown") {
      return claude;
    }
  }
  return parseRateLimitsBlock(rateLimits, "providerSession", observedAt);
}

const make = () =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const changes = yield* PubSub.unbounded<AgentLimitsSnapshot>();
    const mutex = yield* Semaphore.make(1);
    const tracked = yield* Ref.make<ReadonlyMap<string, TrackedProvider>>(new Map());
    const polled = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ProviderLimitSnapshot>>>(
      new Map(),
    );

    const buildSnapshot = Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const live = [...(yield* Ref.get(tracked)).values()].map(toSnapshotRow);
      const polledRows = [...(yield* Ref.get(polled)).values()].flat();
      // A polled row per account beats one live row per driver: claude-swap
      // already covers the running Claude account, and a live Codex event is
      // fresher than the session log it will later be written to.
      const polledDrivers = new Set(polledRows.map((row) => row.driver));
      const liveDrivers = new Set(live.map((row) => row.driver));
      const providers = [
        ...live.filter((row) => row.driver !== "claude" || !polledDrivers.has(row.driver)),
        ...polledRows.filter((row) => row.driver === "claude" || !liveDrivers.has(row.driver)),
      ];
      return {
        readAt,
        providers: providers.sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
      } satisfies AgentLimitsSnapshot;
    });

    const setPolled = (sourceKey: string, rows: ReadonlyArray<ProviderLimitSnapshot>) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.update(polled, (current) => new Map(current).set(sourceKey, rows));
          yield* PubSub.publish(changes, yield* buildSnapshot);
        }),
      );

    const ingest = Effect.fn("agentLimits.ingest")(function* (
      driver: ProviderDriverKind,
      instanceId: ProviderInstanceId | undefined,
      rateLimits: unknown,
    ) {
      const now = yield* DateTime.now;
      const nowSeconds = DateTime.toEpochMillis(now) / 1000;
      const incoming = readEvent(driver, rateLimits, nowSeconds);

      const key = trackingKey(driver, instanceId);
      const changed = yield* Ref.modify(tracked, (current) => {
        const previous = current.get(key)?.state ?? EMPTY_LIMIT_STATE;
        const merged = mergeLimitState(previous, incoming, nowSeconds);
        // An event that told us nothing new must not wake every client.
        if (merged === EMPTY_LIMIT_STATE && previous === EMPTY_LIMIT_STATE) {
          return [false, current] as const;
        }
        const next = new Map(current);
        next.set(key, {
          instanceId: (instanceId ?? driver) as ProviderInstanceId,
          driver,
          state: merged,
        });
        return [true, next as ReadonlyMap<string, TrackedProvider>] as const;
      });

      if (!changed) {
        return;
      }
      yield* PubSub.publish(changes, yield* buildSnapshot);
    });

    yield* providerService.streamEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "account.rate-limits.updated"
          ? ingest(event.provider, event.providerInstanceId, event.payload.rateLimits)
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    const subscribe = subscribeBeforeSnapshot(changes, buildSnapshot, mutex);

    return {
      latest: buildSnapshot,
      changes: Stream.fromPubSub(changes),
      subscribe,
      setPolled,
    } as const;
  });

export const layer = Layer.effect(AgentLimits, make());
