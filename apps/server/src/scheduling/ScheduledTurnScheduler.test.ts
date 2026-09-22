import {
  CommandId,
  type OrchestrationCommand,
  ProviderInstanceId,
  type ScheduleTurnInput,
  ThreadId,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ScheduledTurns from "../persistence/ScheduledTurns.ts";
import * as ScheduledTurnScheduler from "./ScheduledTurnScheduler.ts";

/**
 * A recording engine. `failWith` lets a test make dispatch fail the way the
 * real engine does — with a typed orchestration error — so the failure path
 * is exercised rather than simulated.
 */
const makeEngineStub = Effect.gen(function* () {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const failure = yield* Ref.make<string | null>(null);

  const service: OrchestrationEngineShape = {
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.gen(function* () {
        const detail = yield* Ref.get(failure);
        if (detail !== null) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({ commandType: command.type, detail }),
          );
        }
        yield* Ref.update(dispatched, (commands) => [...commands, command]);
        // Sequence numbers mean nothing to the scheduler.
        return { sequence: 1 };
      }),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  };

  return {
    dispatched,
    failure,
    layer: Layer.succeed(OrchestrationEngineService, service),
  };
});

/**
 * A read model holding one thread, so a test can say whether that thread has
 * already started talking to a provider. `undefined` means the scheduler finds
 * no thread at all, which is the case where it has nothing to reason about.
 */
const projectionLayer = (session?: { readonly status: string } | undefined) =>
  Layer.succeed(ProjectionSnapshotQuery)({
    getThreadDetailById: () =>
      Effect.succeed(
        Option.some({
          session: session ?? null,
          modelSelection: { instanceId: "codex", model: "gpt-5", options: [] },
        }),
      ),
  } as unknown as ProjectionSnapshotQueryShape);

const testLayer = (
  engineLayer: Layer.Layer<OrchestrationEngineService>,
  session?: { readonly status: string } | undefined,
) =>
  ScheduledTurnScheduler.layer.pipe(
    Layer.provide(engineLayer),
    Layer.provide(projectionLayer(session)),
    Layer.provide(ScheduledTurns.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );

const iso = (offsetMillis: number) =>
  Effect.map(DateTime.now, (now) =>
    DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) + offsetMillis)),
  );

function input(
  overrides: Partial<ScheduleTurnInput> & Pick<ScheduleTurnInput, "runAt" | "commandId">,
): ScheduleTurnInput {
  return {
    threadId: ThreadId.make("thread-1"),
    prompt: "run the nightly sweep",
    ...overrides,
  };
}

describe("ScheduledTurnScheduler", () => {
  effectIt.live("dispatches a turn whose time has passed", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const dispatched = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        yield* scheduler.schedule(
          input({
            runAt: yield* iso(-60_000),
            commandId: CommandId.make("cmd-past"),
            prompt: "summarise yesterday",
            threadId: ThreadId.make("thread-past"),
          }),
        );
        yield* scheduler.runDuePass;
        return yield* Ref.get(stub.dispatched);
      }).pipe(Effect.provide(testLayer(stub.layer)), Effect.scoped);

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0]!;
      expect(command.type).toBe("thread.turn.start");
      if (command.type !== "thread.turn.start") {
        throw new Error("expected a thread.turn.start command");
      }
      expect(command.threadId).toBe("thread-past");
      expect(command.message.text).toBe("summarise yesterday");
      expect(command.message.role).toBe("user");
    }),
  );

  effectIt.live("leaves a turn scheduled for later alone", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const result = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        yield* scheduler.schedule(
          input({ runAt: yield* iso(3_600_000), commandId: CommandId.make("cmd-future") }),
        );
        yield* scheduler.runDuePass;
        const list = yield* scheduler.latest;
        return { dispatched: yield* Ref.get(stub.dispatched), list };
      }).pipe(Effect.provide(testLayer(stub.layer)), Effect.scoped);

      expect(result.dispatched).toHaveLength(0);
      expect(result.list.scheduled).toHaveLength(1);
      expect(result.list.scheduled[0]!.status).toBe("pending");
    }),
  );

  effectIt.live("claims a due row exactly once across two passes", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const dispatched = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        yield* scheduler.schedule(
          input({ runAt: yield* iso(-1_000), commandId: CommandId.make("cmd-once") }),
        );
        yield* scheduler.runDuePass;
        yield* scheduler.runDuePass;
        return yield* Ref.get(stub.dispatched);
      }).pipe(Effect.provide(testLayer(stub.layer)), Effect.scoped);

      expect(dispatched).toHaveLength(1);
    }),
  );

  effectIt.live("cancels a pending turn and refuses to cancel a dispatched one", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const result = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        const pending = yield* scheduler.schedule(
          input({ runAt: yield* iso(-1_000), commandId: CommandId.make("cmd-cancel") }),
        );
        const firstCancel = yield* scheduler.cancel({ id: pending.id });
        yield* scheduler.runDuePass;

        const fired = yield* scheduler.schedule(
          input({ runAt: yield* iso(-1_000), commandId: CommandId.make("cmd-fired") }),
        );
        yield* scheduler.runDuePass;
        const secondCancel = yield* scheduler.cancel({ id: fired.id });

        return {
          firstCancel,
          secondCancel,
          dispatched: yield* Ref.get(stub.dispatched),
          list: yield* scheduler.latest,
        };
      }).pipe(Effect.provide(testLayer(stub.layer)), Effect.scoped);

      expect(result.firstCancel.cancelled).toBe(true);
      expect(result.secondCancel.cancelled).toBe(false);
      // Only the turn that was never cancelled reached the engine.
      expect(result.dispatched).toHaveLength(1);
      const cancelled = result.list.scheduled.find((turn) => turn.id.endsWith("cmd-cancel"));
      expect(cancelled?.status).toBe("cancelled");
    }),
  );

  effectIt.live("records why a dispatch failed and does not retry it", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const result = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        yield* Ref.set(stub.failure, "thread is gone");
        yield* scheduler.schedule(
          input({ runAt: yield* iso(-1_000), commandId: CommandId.make("cmd-fail") }),
        );
        yield* scheduler.runDuePass;
        // A later pass must not pick the failed row back up.
        yield* Ref.set(stub.failure, null);
        yield* scheduler.runDuePass;
        return { dispatched: yield* Ref.get(stub.dispatched), list: yield* scheduler.latest };
      }).pipe(Effect.provide(testLayer(stub.layer)), Effect.scoped);

      expect(result.dispatched).toHaveLength(0);
      expect(result.list.scheduled).toHaveLength(1);
      const failed = result.list.scheduled[0]!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("thread is gone");
    }),
  );

  /**
   * The bug this pins down: a row remembers the model that was selected when it
   * was queued, and replaying that on a thread which has since started talking
   * to a provider asks for a mid-conversation model change. Providers that
   * refuse one reject the turn downstream — and because the row was claimed
   * before dispatch, it reports itself as dispatched while nothing ever runs.
   */
  effectIt.live("drops the remembered model when the thread already has a session", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const dispatched = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        yield* scheduler.schedule(
          input({
            runAt: yield* iso(-1_000),
            commandId: CommandId.make("cmd-started-session"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
              options: [],
            },
          }),
        );
        yield* scheduler.runDuePass;
        return yield* Ref.get(stub.dispatched);
      }).pipe(Effect.provide(testLayer(stub.layer, { status: "ready" })), Effect.scoped);

      expect(dispatched).toHaveLength(1);
      const command = dispatched[0]!;
      if (command.type !== "thread.turn.start") {
        throw new Error("expected a thread.turn.start command");
      }
      // No selection at all: the turn runs on whatever the session is using,
      // exactly as a follow-up typed into the composer would.
      expect(command.modelSelection).toBeUndefined();
    }),
  );

  effectIt.live("keeps the remembered model when the thread has not started yet", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const dispatched = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        yield* scheduler.schedule(
          input({
            runAt: yield* iso(-1_000),
            commandId: CommandId.make("cmd-no-session"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
              options: [],
            },
          }),
        );
        yield* scheduler.runDuePass;
        return yield* Ref.get(stub.dispatched);
      }).pipe(Effect.provide(testLayer(stub.layer, undefined)), Effect.scoped);

      const command = dispatched[0]!;
      if (command.type !== "thread.turn.start") {
        throw new Error("expected a thread.turn.start command");
      }
      // Nothing is bound yet, so the model chosen when queueing still decides.
      expect(command.modelSelection?.model).toBe("gpt-5-codex");
    }),
  );

  effectIt.live("keeps the remembered model when the previous session was stopped", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const dispatched = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        yield* scheduler.schedule(
          input({
            runAt: yield* iso(-1_000),
            commandId: CommandId.make("cmd-stopped-session"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
              options: [],
            },
          }),
        );
        yield* scheduler.runDuePass;
        return yield* Ref.get(stub.dispatched);
      }).pipe(Effect.provide(testLayer(stub.layer, { status: "stopped" })), Effect.scoped);

      const command = dispatched[0]!;
      if (command.type !== "thread.turn.start") {
        throw new Error("expected a thread.turn.start command");
      }
      // A stopped session binds nothing; the next turn may pick its own model.
      expect(command.modelSelection?.model).toBe("gpt-5-codex");
    }),
  );

  effectIt.live("queues the same command id only once", () =>
    Effect.gen(function* () {
      const stub = yield* makeEngineStub;

      const result = yield* Effect.gen(function* () {
        const scheduler = yield* ScheduledTurnScheduler.ScheduledTurnScheduler;
        const runAt = yield* iso(3_600_000);
        const first = yield* scheduler.schedule(
          input({ runAt, commandId: CommandId.make("cmd-idempotent") }),
        );
        const second = yield* scheduler.schedule(
          input({ runAt, commandId: CommandId.make("cmd-idempotent"), prompt: "different text" }),
        );
        return { first, second, list: yield* scheduler.latest };
      }).pipe(Effect.provide(testLayer(stub.layer)), Effect.scoped);

      expect(result.list.scheduled).toHaveLength(1);
      expect(result.second.id).toBe(result.first.id);
      // The first write wins; a retry must not quietly rewrite the work.
      expect(result.second.prompt).toBe(result.first.prompt);
    }),
  );
});
