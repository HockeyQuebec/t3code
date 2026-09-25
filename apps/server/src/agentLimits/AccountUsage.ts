import type {
  AccountUsageEntry,
  AccountUsageSnapshot,
  ProviderDriverKind,
  ProviderLimitSnapshot,
  ProviderRuntimeEvent,
  SpendTokens,
  ThreadAccountUsage,
  ThreadId,
  ThreadUsageSnapshot,
} from "@t3tools/contracts";
import {
  type AccountAttribution,
  type AccountReading,
  attributeReading,
  EMPTY_ATTRIBUTION,
  sameWindow,
  turnTokens,
  type UsageMeter,
  type UsageTurn,
} from "@t3tools/shared/accountUsage";
import { DEFAULT_RATES, priceTurn } from "@t3tools/shared/tokenPricing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { AgentLimits } from "./AgentLimits.ts";

/**
 * Per-account and per-chat usage on this device.
 *
 * Every finished turn is priced and tagged with the account it ran on — for
 * Claude, the claude-swap account active when the turn started. Meter readings
 * from {@link AgentLimits} are then split across those turns (see
 * `@t3tools/shared/accountUsage`). Turns are kept on disk so a chat's cost
 * survives a restart.
 */
export class AccountUsage extends Context.Service<
  AccountUsage,
  {
    readonly accounts: Stream.Stream<AccountUsageSnapshot>;
    readonly thread: (threadId: ThreadId) => Stream.Stream<ThreadUsageSnapshot>;
  }
>()("t3/agentLimits/AccountUsage") {}

const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;
const MAX_TURNS = 20_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const FLUSH_INTERVAL = "30 seconds";

interface AccountInfo {
  readonly label: string;
  readonly driver: string;
  readonly fiveHour: UsageMeter | null;
  readonly weekly: UsageMeter | null;
}

export interface AccountUsageState {
  readonly turns: ReadonlyArray<UsageTurn>;
  readonly attribution: Readonly<Record<string, AccountAttribution>>;
  readonly accounts: Readonly<Record<string, AccountInfo>>;
}

const EMPTY_STATE: AccountUsageState = { turns: [], attribution: {}, accounts: {} };

/** Hand-narrowed rather than schema-decoded: a bad file just starts empty. */
const UnknownJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeJson = Schema.decodeUnknownOption(UnknownJson);
const encodeJson = Schema.encodeSync(UnknownJson);

const sameMeter = (left: UsageMeter | null, right: UsageMeter | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.usedPercent === right.usedPercent &&
    left.resetsAt === right.resetsAt);

const sameInfo = (left: AccountInfo | undefined, right: AccountInfo) =>
  left !== undefined &&
  left.label === right.label &&
  left.driver === right.driver &&
  sameMeter(left.fiveHour, right.fiveHour) &&
  sameMeter(left.weekly, right.weekly);

function loadState(raw: unknown): AccountUsageState {
  if (typeof raw !== "object" || raw === null) return EMPTY_STATE;
  const value = raw as Partial<AccountUsageState> & { readonly version?: unknown };
  if (value.version !== 1 || !Array.isArray(value.turns)) return EMPTY_STATE;
  return {
    turns: value.turns,
    attribution: value.attribution ?? {},
    accounts: value.accounts ?? {},
  };
}

function finiteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(Math.round(value), 0) : 0;
}

function toMeter(window: ProviderLimitSnapshot["short"]): UsageMeter | null {
  return Option.match(window, {
    onNone: () => null,
    onSome: (entry) => ({
      usedPercent: entry.usedPercent,
      resetsAt: Option.match(entry.resetsAt, {
        onNone: () => null,
        onSome: DateTime.toEpochMillis,
      }),
    }),
  });
}

/** The model that did most of a Claude turn's output, from its `modelUsage`. */
function dominantModel(modelUsage: Record<string, unknown> | undefined): string | null {
  if (modelUsage === undefined) return null;
  let best: { readonly model: string; readonly output: number } | null = null;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const output = finiteInt((usage as { outputTokens?: unknown } | null)?.outputTokens);
    if (best === null || output > best.output) best = { model, output };
  }
  return best?.model ?? null;
}

function emptyTokens(): { -readonly [K in keyof SpendTokens]: number } {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

/** The account's current window, or null once it has reset. */
function liveReset(meter: UsageMeter | null, nowMillis: number): number | null {
  const resetsAt = meter?.resetsAt ?? null;
  return resetsAt !== null && resetsAt > nowMillis ? resetsAt : null;
}

function inWindow(turnReset: number | null, meter: UsageMeter | null, nowMillis: number): boolean {
  const reset = liveReset(meter, nowMillis);
  return reset !== null && sameWindow(turnReset, reset);
}

export function summarizeAccounts(
  state: AccountUsageState,
  nowMillis: number,
): ReadonlyArray<AccountUsageEntry> {
  const keys = new Set([
    ...Object.keys(state.accounts),
    ...state.turns.map((turn) => turn.account),
  ]);
  return [...keys].map((account) => {
    const info = state.accounts[account];
    const turns = state.turns.filter((turn) => turn.account === account);
    const fiveHourReset = liveReset(info?.fiveHour ?? null, nowMillis);
    const windowStart = (fiveHourReset ?? nowMillis) - FIVE_HOURS_MS;
    const windowTurns = turns.filter((turn) => turn.atMillis >= windowStart);
    const attribution = state.attribution[account] ?? EMPTY_ATTRIBUTION;
    const fiveHour = info?.fiveHour ?? null;
    const weekly = info?.weekly ?? null;
    return {
      account,
      label: info?.label ?? account,
      driver: (info?.driver ?? turns[0]?.driver ?? "claudeAgent") as ProviderDriverKind,
      turns: turns.length,
      tokens: turns.reduce((sum, turn) => sum + turnTokens(turn), 0),
      costUsd: turns.reduce((sum, turn) => sum + turn.costUsd, 0),
      windowTurns: windowTurns.length,
      windowTokens: windowTurns.reduce((sum, turn) => sum + turnTokens(turn), 0),
      windowCostUsd: windowTurns.reduce((sum, turn) => sum + turn.costUsd, 0),
      fiveHourPercent: turns
        .filter((turn) => inWindow(turn.fiveHourResetsAt, fiveHour, nowMillis))
        .reduce((sum, turn) => sum + turn.fiveHourPercent, 0),
      weeklyPercent: turns
        .filter((turn) => inWindow(turn.weeklyResetsAt, weekly, nowMillis))
        .reduce((sum, turn) => sum + turn.weeklyPercent, 0),
      otherFiveHourPercent: inWindow(attribution.otherFiveHourResetsAt, fiveHour, nowMillis)
        ? attribution.otherFiveHour
        : 0,
      otherWeeklyPercent: inWindow(attribution.otherWeeklyResetsAt, weekly, nowMillis)
        ? attribution.otherWeekly
        : 0,
    } satisfies AccountUsageEntry;
  });
}

export function summarizeThread(
  state: AccountUsageState,
  threadId: ThreadId,
  nowMillis: number,
): ThreadUsageSnapshot {
  const byAccount = new Map<string, ReturnType<typeof newThreadAccount>>();
  function newThreadAccount(account: string) {
    return {
      account,
      label: state.accounts[account]?.label ?? account,
      turns: 0,
      tokens: emptyTokens(),
      costUsd: 0,
      fiveHourPercent: 0,
      windowFiveHourPercent: 0,
      weeklyPercent: 0,
    };
  }
  for (const turn of state.turns) {
    if (turn.threadId !== threadId) continue;
    const entry = byAccount.get(turn.account) ?? newThreadAccount(turn.account);
    entry.turns += 1;
    entry.tokens.inputTokens += turn.inputTokens;
    entry.tokens.outputTokens += turn.outputTokens;
    entry.tokens.cacheReadTokens += turn.cacheReadTokens;
    entry.tokens.cacheWriteTokens += turn.cacheWriteTokens;
    entry.tokens.totalTokens += turnTokens(turn);
    entry.costUsd += turn.costUsd;
    entry.fiveHourPercent += turn.fiveHourPercent;
    entry.weeklyPercent += turn.weeklyPercent;
    if (
      inWindow(turn.fiveHourResetsAt, state.accounts[turn.account]?.fiveHour ?? null, nowMillis)
    ) {
      entry.windowFiveHourPercent += turn.fiveHourPercent;
    }
    byAccount.set(turn.account, entry);
  }
  const accounts: ReadonlyArray<ThreadAccountUsage> = [...byAccount.values()];
  const tokens = emptyTokens();
  for (const entry of accounts) {
    for (const key of Object.keys(tokens) as Array<keyof SpendTokens>) {
      tokens[key] += entry.tokens[key];
    }
  }
  const sum = (pick: (entry: ThreadAccountUsage) => number) =>
    accounts.reduce((total, entry) => total + pick(entry), 0);
  return {
    threadId,
    turns: sum((entry) => entry.turns),
    tokens,
    costUsd: sum((entry) => entry.costUsd),
    fiveHourPercent: sum((entry) => entry.fiveHourPercent),
    windowFiveHourPercent: sum((entry) => entry.windowFiveHourPercent),
    weeklyPercent: sum((entry) => entry.weeklyPercent),
    byAccount: accounts,
  };
}

/** Which threads a change touched; `null` means every view should refresh. */
type Change = ReadonlySet<string> | null;

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const agentLimits = yield* AgentLimits;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const filePath = `${config.stateDir}/account-usage.json`;

  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.map((text) => loadState(Option.getOrNull(decodeJson(text)))),
    Effect.orElseSucceed(() => EMPTY_STATE),
  );
  const state = yield* Ref.make<AccountUsageState>(initial);
  const dirty = yield* Ref.make(false);
  /** Threads mid-turn, and the account each started on. */
  const running = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const changes = yield* PubSub.unbounded<Change>();
  const limits = yield* Ref.make<ReadonlyArray<ProviderLimitSnapshot>>([]);

  const commit = (next: AccountUsageState, change: Change) =>
    Ref.set(state, next).pipe(
      Effect.andThen(Ref.set(dirty, true)),
      Effect.andThen(PubSub.publish(changes, change)),
    );

  /** The account a new turn on `driver` is billed to. */
  const accountFor = (driver: string) =>
    Ref.get(limits).pipe(
      Effect.map((rows) => {
        const forDriver = rows.filter((row) => row.driver === driver);
        const row = forDriver.find((entry) => entry.active === true) ?? forDriver[0];
        return row?.instanceId ?? driver;
      }),
    );

  const recordTurn = Effect.fn("accountUsage.recordTurn")(function* (input: {
    readonly id: string;
    readonly threadId: string;
    readonly driver: string;
    readonly model: string | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  }) {
    if (turnTokens(input) === 0) return;
    const account =
      (yield* Ref.get(running)).get(input.threadId) ?? (yield* accountFor(input.driver));
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const priced = priceTurn({ ...input, provider: input.driver }, DEFAULT_RATES);
    const turn: UsageTurn = {
      ...input,
      account,
      atMillis: nowMillis,
      costUsd: priced.reportedCostUsd + priced.estimatedCostUsd,
      fiveHourPercent: 0,
      fiveHourResetsAt: null,
      weeklyPercent: 0,
      weeklyResetsAt: null,
      open: true,
    };
    const current = yield* Ref.get(state);
    const kept = current.turns.filter((entry) => nowMillis - entry.atMillis < RETENTION_MS);
    yield* commit(
      { ...current, turns: [...kept.slice(-(MAX_TURNS - 1)), turn] },
      new Set([input.threadId]),
    );
  });

  const onEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const threadId = event.threadId as string;
      switch (event.type) {
        case "turn.started": {
          const account = yield* accountFor(event.provider);
          yield* Ref.update(running, (current) => new Map(current).set(threadId, account));
          return;
        }
        case "turn.completed": {
          // Claude reports a turn's tokens only here; the token-usage events it
          // emits carry context size, not what the turn consumed.
          if (event.provider === "claudeAgent") {
            const usage = (event.payload.usage ?? {}) as Record<string, unknown>;
            yield* recordTurn({
              id: event.eventId,
              threadId,
              driver: event.provider,
              model: dominantModel(event.payload.modelUsage),
              inputTokens: finiteInt(usage.input_tokens),
              outputTokens: finiteInt(usage.output_tokens),
              cacheReadTokens: finiteInt(usage.cache_read_input_tokens),
              cacheWriteTokens: finiteInt(usage.cache_creation_input_tokens),
            });
          }
          yield* Ref.update(running, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          });
          return;
        }
        case "turn.aborted": {
          yield* Ref.update(running, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          });
          return;
        }
        case "thread.token-usage.updated": {
          if (event.provider === "claudeAgent") return;
          const usage = event.payload.usage;
          const input = finiteInt(usage.lastInputTokens);
          const cacheRead = finiteInt(usage.lastCachedInputTokens);
          // Codex counts cached reads inside its input total.
          yield* recordTurn({
            id: event.eventId,
            threadId,
            driver: event.provider,
            model: null,
            inputTokens: Math.max(input - cacheRead, 0),
            outputTokens: finiteInt(usage.lastOutputTokens),
            cacheReadTokens: cacheRead,
            cacheWriteTokens: 0,
          });
          return;
        }
        default:
          return;
      }
    });

  const onLimits = (rows: ReadonlyArray<ProviderLimitSnapshot>) =>
    Effect.gen(function* () {
      yield* Ref.set(limits, rows);
      const runningAccounts = new Set((yield* Ref.get(running)).values());
      let next = yield* Ref.get(state);
      const touched = new Set<string>();
      let changed = false;
      for (const row of rows) {
        const account = row.instanceId as string;
        const fiveHour = toMeter(row.short);
        const weekly = toMeter(row.long);
        const info: AccountInfo = { label: row.label, driver: row.driver, fiveHour, weekly };
        const previous = next.accounts[account];
        if (!sameInfo(previous, info)) {
          next = { ...next, accounts: { ...next.accounts, [account]: info } };
          changed = true;
        }
        const atMillis = Option.match(row.observedAt, {
          onNone: () => null,
          onSome: DateTime.toEpochMillis,
        });
        const attribution = next.attribution[account] ?? EMPTY_ATTRIBUTION;
        if (atMillis === null || attribution.last?.atMillis === atMillis) continue;
        const reading: AccountReading = { atMillis, fiveHour, weekly };
        const folded = attributeReading({
          state: attribution,
          turns: next.turns,
          account,
          reading,
          running: runningAccounts.has(account),
        });
        for (const [index, turn] of folded.turns.entries()) {
          if (turn !== next.turns[index]) touched.add(turn.threadId);
        }
        next = {
          ...next,
          turns: folded.turns,
          attribution: { ...next.attribution, [account]: folded.state },
        };
        changed = true;
      }
      if (changed) {
        yield* commit(next, touched);
      }
    });

  const flush = Effect.gen(function* () {
    if (!(yield* Ref.getAndSet(dirty, false))) return;
    const current = yield* Ref.get(state);
    yield* writeFileStringAtomically({
      filePath,
      contents: encodeJson({ version: 1, ...current }),
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.ignore);
  });

  yield* providerService.streamEvents.pipe(Stream.runForEach(onEvent), Effect.forkScoped);
  yield* agentLimits.subscribe.pipe(
    Effect.flatMap(({ latest, changes: limitChanges }) =>
      onLimits(latest.providers).pipe(
        Effect.andThen(
          limitChanges.pipe(Stream.runForEach((snapshot) => onLimits(snapshot.providers))),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* flush.pipe(Effect.repeat(Schedule.spaced(FLUSH_INTERVAL)), Effect.forkScoped);
  yield* Effect.addFinalizer(() => flush);

  const snapshotAccounts = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const current = yield* Ref.get(state);
    const oldest = current.turns[0]?.atMillis;
    return {
      readAt: now,
      since: oldest === undefined ? Option.none() : Option.some(DateTime.makeUnsafe(oldest)),
      accounts: summarizeAccounts(current, DateTime.toEpochMillis(now)),
    } satisfies AccountUsageSnapshot;
  });

  const snapshotThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return summarizeThread(yield* Ref.get(state), threadId, DateTime.toEpochMillis(now));
    });

  /** Subscribes before reading, so a change between the two is never lost. */
  const watch = <A>(snapshot: Effect.Effect<A>, relevant: (change: Change) => boolean) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const latest = yield* snapshot;
        return Stream.concat(
          Stream.make(latest),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(relevant),
            Stream.mapEffect(() => snapshot),
          ),
        );
      }),
    );

  return AccountUsage.of({
    accounts: watch(snapshotAccounts, () => true),
    thread: (threadId) =>
      watch(snapshotThread(threadId), (change) => change === null || change.has(threadId)),
  });
});

export const layer = Layer.effect(AccountUsage, make);
