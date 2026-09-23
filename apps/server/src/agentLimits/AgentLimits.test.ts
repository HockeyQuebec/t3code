import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import * as AgentLimits from "./AgentLimits.ts";
import * as SpendLedger from "./SpendLedger.ts";

const makeProviderServiceStub = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: () => unsupported(),
    rollbackConversation: () => unsupported(),
    compactThread: () => unsupported(),
    assertConversationRollbackSupported: () => unsupported(),
    uploadFeedback: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(events);
    },
  };

  return { events, layer: Layer.succeed(ProviderService, service) };
});

let eventCounter = 0;

type TestWindow = {
  readonly kind: "session" | "weekly";
  readonly usedPercent: number;
  readonly windowDurationMins?: number;
  readonly resetsAt?: string;
};

function rateLimitEvent(driver: string, windows: ReadonlyArray<TestWindow>): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(`event-${driver}-${(eventCounter += 1)}`),
    provider: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(driver),
    threadId: ThreadId.make("thread-1"),
    createdAt: "2026-08-05T00:00:00.000Z",
    type: "account.rate-limits.updated",
    payload: {
      limits: {
        windows: windows.map((window) => ({ id: window.kind, label: window.kind, ...window })),
      },
    },
  } as unknown as ProviderRuntimeEvent;
}

function tokenUsageEvent(
  driver: string,
  lastInput: number,
  lastOutput: number,
): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(`usage-${driver}-${(eventCounter += 1)}`),
    provider: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(driver),
    threadId: ThreadId.make("thread-1"),
    createdAt: "2026-08-05T00:00:00.000Z",
    type: "thread.token-usage.updated",
    payload: {
      usage: {
        usedTokens: lastInput + lastOutput,
        lastInputTokens: lastInput,
        lastOutputTokens: lastOutput,
        lastCachedInputTokens: 0,
      },
    },
  } as ProviderRuntimeEvent;
}

/**
 * A PubSub only delivers to subscribers it already has, and the service
 * subscribes on a forked fiber, so a test has to let that fiber reach the
 * subscription before publishing anything at it.
 */
const subscribed = Effect.sleep("50 millis");

/** Let the service's forked consumer drain what was published before asserting. */
const settle = Effect.sleep("50 millis");

describe("AgentLimits", () => {
  effectIt.live("folds a Codex rate-limit announcement into a snapshot", () =>
    Effect.gen(function* () {
      const stub = yield* makeProviderServiceStub;

      const result = yield* Effect.gen(function* () {
        const limits = yield* AgentLimits.AgentLimits;
        yield* subscribed;
        yield* PubSub.publish(
          stub.events,
          rateLimitEvent("codex", [
            {
              kind: "session",
              usedPercent: 40,
              windowDurationMins: 300,
              resetsAt: "2027-01-15T08:00:00.000Z",
            },
            { kind: "weekly", usedPercent: 9, windowDurationMins: 10_080 },
          ]),
        );
        yield* settle;
        return yield* limits.latest;
      }).pipe(Effect.provide(AgentLimits.layer.pipe(Layer.provide(stub.layer))), Effect.scoped);

      expect(result.providers).toHaveLength(1);
      const provider = result.providers[0]!;
      expect(provider.driver).toBe("codex");
      expect(Option.getOrNull(provider.binding)?.usedPercent).toBe(40);
      // 60% headroom is a window worth starting something big in.
      expect(provider.level).toBe("fresh");
      // The weekly figure is kept for context but does not bind.
      expect(Option.getOrNull(provider.long)?.usedPercent).toBe(9);
    }),
  );

  effectIt.live("keeps the window a sparse Claude update did not mention", () =>
    Effect.gen(function* () {
      const stub = yield* makeProviderServiceStub;

      const result = yield* Effect.gen(function* () {
        const limits = yield* AgentLimits.AgentLimits;
        yield* subscribed;
        yield* PubSub.publish(
          stub.events,
          rateLimitEvent("claude", [{ kind: "weekly", usedPercent: 10 }]),
        );
        yield* settle;
        yield* PubSub.publish(
          stub.events,
          rateLimitEvent("claude", [{ kind: "session", usedPercent: 90 }]),
        );
        yield* settle;
        return yield* limits.latest;
      }).pipe(Effect.provide(AgentLimits.layer.pipe(Layer.provide(stub.layer))), Effect.scoped);

      const provider = result.providers[0]!;
      // The weekly figure survives the five-hour update that never mentioned it.
      expect(Option.getOrNull(provider.long)?.usedPercent).toBeCloseTo(10, 5);
      expect(Option.getOrNull(provider.short)?.usedPercent).toBeCloseTo(90, 5);
      expect(provider.level).toBe("low");
    }),
  );

  effectIt.live("lets per-account polled Claude rows replace the live per-driver one", () =>
    Effect.gen(function* () {
      const stub = yield* makeProviderServiceStub;

      const result = yield* Effect.gen(function* () {
        const limits = yield* AgentLimits.AgentLimits;
        yield* subscribed;
        yield* PubSub.publish(
          stub.events,
          rateLimitEvent("claude", [{ kind: "session", usedPercent: 50 }]),
        );
        yield* settle;
        const polledRow = { ...(yield* limits.latest).providers[0]! };
        yield* limits.setPolled("cswap", [
          { ...polledRow, instanceId: ProviderInstanceId.make("cswap-1"), label: "a@example.com" },
          { ...polledRow, instanceId: ProviderInstanceId.make("cswap-2"), label: "b@example.com" },
        ]);
        return yield* limits.latest;
      }).pipe(Effect.provide(AgentLimits.layer.pipe(Layer.provide(stub.layer))), Effect.scoped);

      expect(result.providers.map((provider) => provider.instanceId)).toEqual([
        "cswap-1",
        "cswap-2",
      ]);
    }),
  );
});

describe("SpendLedger", () => {
  effectIt.live("prices unpriced token counts instead of reporting nothing", () =>
    Effect.gen(function* () {
      const stub = yield* makeProviderServiceStub;

      const summary = yield* Effect.gen(function* () {
        const ledger = yield* SpendLedger.SpendLedger;
        yield* subscribed;
        yield* PubSub.publish(stub.events, tokenUsageEvent("codex", 1_000_000, 100_000));
        yield* settle;
        return yield* ledger.summarize({ window: "today" });
      }).pipe(Effect.provide(SpendLedger.layer.pipe(Layer.provide(stub.layer))), Effect.scoped);

      expect(summary.total.turns).toBe(1);
      expect(summary.total.reportedCostUsd).toBe(0);
      expect(summary.total.estimatedCostUsd).toBeGreaterThan(0);
      expect(summary.total.costSource).toBe("estimated");
      // The panel has to be able to show which rates it used.
      expect(summary.assumptions.map((row) => row.key)).toContain("gpt-5");
    }),
  );

  effectIt.live("ignores an update that reports no work for the last turn", () =>
    Effect.gen(function* () {
      const stub = yield* makeProviderServiceStub;

      const summary = yield* Effect.gen(function* () {
        const ledger = yield* SpendLedger.SpendLedger;
        yield* subscribed;
        yield* PubSub.publish(stub.events, tokenUsageEvent("codex", 0, 0));
        yield* settle;
        return yield* ledger.summarize({ window: "today" });
      }).pipe(Effect.provide(SpendLedger.layer.pipe(Layer.provide(stub.layer))), Effect.scoped);

      expect(summary.total.turns).toBe(0);
      expect(summary.total.costSource).toBe("none");
    }),
  );
});
