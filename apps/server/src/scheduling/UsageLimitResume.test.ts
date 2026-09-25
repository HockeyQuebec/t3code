import {
  type AgentLimitsSnapshot,
  EventId,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ScheduledTurn,
  ScheduledTurnId,
  type ScheduleTurnInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { AgentLimits } from "../agentLimits/AgentLimits.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import { ScheduledTurnScheduler } from "./ScheduledTurnScheduler.ts";
import * as UsageLimitResume from "./UsageLimitResume.ts";

const THREAD = ThreadId.make("thread-1");
const TURN = TurnId.make("turn-1");
/**
 * Every test below runs on the live clock and takes "now" from it.
 * `parseResetEpochFromText` only believes a reset time in the near future, so a
 * fixture epoch has to be near the clock the code under test actually reads.
 */
const nowSeconds = Effect.map(DateTime.now, (now) =>
  Math.floor(DateTime.toEpochMillis(now) / 1000),
);

const unsupported = () => Effect.die(new Error("Unsupported call in test")) as never;

let eventCounter = 0;

function event(
  overrides: Partial<ProviderRuntimeEvent> & Pick<ProviderRuntimeEvent, "type" | "payload">,
  driver = "claude",
): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(`event-${(eventCounter += 1)}`),
    provider: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(driver),
    threadId: THREAD,
    turnId: TURN,
    createdAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  } as ProviderRuntimeEvent;
}

const turnFailed = (errorMessage: string | undefined, driver = "claude") =>
  event(
    {
      type: "turn.completed",
      payload: {
        state: "failed",
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
    },
    driver,
  );

/** A thread detail with only the fields this service reads. */
function threadDetail(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD,
    worktreePath: null,
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude"),
      model: "sonnet",
      options: [],
    },
    messages: [{ id: "message-1", role: "user", text: "Add a retry to the uploader" }],
    ...overrides,
  } as unknown as OrchestrationThread;
}

interface Harness {
  readonly resume: UsageLimitResume.UsageLimitResume["Service"];
  readonly scheduled: Ref.Ref<ReadonlyArray<ScheduledTurn>>;
  readonly commands: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
}

/**
 * The service with every collaborator stubbed, so a test can feed it exactly
 * the event sequence a real run produces and read back what it queued.
 */
const makeHarness = (input: {
  readonly now: number;
  readonly thread?: OrchestrationThread | undefined;
  readonly limitResetsAt?: number | undefined;
  readonly alreadyScheduled?: ReadonlyArray<ScheduledTurn> | undefined;
}) =>
  Effect.gen(function* () {
    const scheduled = yield* Ref.make<ReadonlyArray<ScheduledTurn>>(input.alreadyScheduled ?? []);
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const providerService: ProviderServiceShape = {
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
        return Stream.empty;
      },
    };

    const schedulerService: ScheduledTurnScheduler["Service"] = {
      schedule: (turnInput: ScheduleTurnInput) =>
        Effect.gen(function* () {
          const row: ScheduledTurn = {
            id: ScheduledTurnId.make(`scheduled-turn:${turnInput.commandId}`),
            threadId: turnInput.threadId,
            prompt: turnInput.prompt,
            origin: turnInput.origin ?? "user",
            ...(turnInput.modelSelection === undefined
              ? {}
              : { modelSelection: turnInput.modelSelection }),
            runAt: turnInput.runAt,
            status: "pending",
            createdAt: "2026-08-05T00:00:00.000Z",
            resolvedAt: null,
            error: null,
          };
          yield* Ref.update(scheduled, (rows) => [...rows, row]);
          return row;
        }),
      update: () => Effect.succeed({ updated: false }),
      cancel: () => unsupported(),
      latest: Effect.map(Ref.get(scheduled), (rows) => ({
        readAt: DateTime.makeUnsafe(input.now * 1000),
        scheduled: rows,
      })),
      changes: Stream.empty,
      subscribe: unsupported(),
      runDuePass: Effect.void,
    };

    const limitsSnapshot: AgentLimitsSnapshot = {
      readAt: DateTime.makeUnsafe(input.now * 1000),
      providers:
        input.limitResetsAt === undefined
          ? []
          : [
              {
                instanceId: ProviderInstanceId.make("claude"),
                driver: ProviderDriverKind.make("claude"),
                label: "claude",
                short: Option.none(),
                long: Option.none(),
                binding: Option.some({
                  usedPercent: 100,
                  resetsAt: Option.some(DateTime.makeUnsafe(input.limitResetsAt * 1000)),
                  windowMinutes: Option.some(300),
                }),
                level: "exhausted",
                source: "providerSession",
                observedAt: Option.none(),
              },
            ],
    };

    const limitsService: AgentLimits["Service"] = {
      latest: Effect.succeed(limitsSnapshot),
      changes: Stream.empty,
      subscribe: unsupported(),
      setPolled: () => Effect.void,
    };

    const projectionService = {
      getThreadDetailById: () =>
        Effect.succeed(input.thread === undefined ? Option.none() : Option.some(input.thread)),
    } as unknown as ProjectionSnapshotQueryShape;

    const engineService = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(commands, (all) => [...all, command]).pipe(Effect.as(undefined)),
      streamDomainEvents: Stream.empty,
    } as unknown as OrchestrationEngineShape;

    const resume = yield* UsageLimitResume.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderService, providerService),
          Layer.succeed(ScheduledTurnScheduler, schedulerService),
          Layer.succeed(AgentLimits, limitsService),
          Layer.succeed(ProjectionSnapshotQuery, projectionService),
          Layer.succeed(OrchestrationEngineService, engineService),
        ),
      ),
      Effect.scoped,
    );

    return { resume, scheduled, commands } satisfies Harness;
  });

describe("UsageLimitResume", () => {
  effectIt.live("queues a conversational thread to carry on after the reset", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
      });

      yield* harness.resume.observe(
        turnFailed(`Claude usage limit reached, resets_at ${now + 1800}`),
      );

      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.origin).toBe("usage-limit");
      expect(rows[0]?.prompt).toContain("Continue the work");
      // The session still holds the conversation, so the task is not restated.
      expect(rows[0]?.prompt).not.toContain("Add a retry to the uploader");

      const runAtSeconds = Date.parse(rows[0]?.runAt ?? "") / 1000;
      expect(runAtSeconds).toBeGreaterThan(now + 1800);

      // And the thread says so, where the failure is.
      const commands = yield* Ref.get(harness.commands);
      expect(commands.map((command) => command.type)).toContain("thread.activity.append");
    }),
  );

  effectIt.live("resumes a harness run from the warning its agent wrote", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({
        now,
        thread: threadDetail({
          modelSelection: {
            instanceId: ProviderInstanceId.make("harness"),
            model: "evaluated_change",
            options: [],
          },
        } as Partial<OrchestrationThread>),
      });

      yield* harness.resume.observe(event({ type: "turn.started", payload: {} }, "harness"));
      // The limit is announced by the agent inside the step, not by the harness.
      yield* harness.resume.observe(
        event(
          {
            type: "runtime.warning",
            payload: {
              message: `implement_section_b: Claude usage limit reached, resets_at ${now + 3600}`,
            },
          },
          "harness",
        ),
      );
      yield* harness.resume.observe(
        event(
          {
            type: "item.completed",
            payload: {
              itemType: "dynamic_tool_call",
              status: "failed",
              title: "implement_section_b",
              data: { node: "implement_section_b", error: "exit code 1" },
            },
          },
          "harness",
        ),
      );
      yield* harness.resume.observe(
        event(
          {
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Agent Harness result",
              data: { status: "failed", workspace: "/tmp/harness/wt-42" },
            },
          },
          "harness",
        ),
      );
      // The harness's own account of the failure says nothing about a limit.
      yield* harness.resume.observe(
        turnFailed("Harness run finished with status 'failed'.", "harness"),
      );

      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      // A batch run has no session to continue: the task must be re-sent, with
      // the same workflow, pointing at the worktree the dead run left behind.
      expect(row?.prompt).toContain("Add a retry to the uploader");
      expect(row?.prompt).toContain("implement_section_b");
      expect(row?.prompt).toContain("/tmp/harness/wt-42");
      expect(row?.modelSelection?.model).toBe("evaluated_change");

      const runAtSeconds = Date.parse(row?.runAt ?? "") / 1000;
      expect(runAtSeconds).toBeGreaterThan(now + 3600);
    }),
  );

  effectIt.live("reads a limit out of the stderr of a harness that died outright", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({ now, thread: threadDetail() });

      yield* harness.resume.observe(
        event(
          {
            type: "runtime.error",
            payload: {
              message: "agent-harness exited with code 1 before reporting a result.",
              class: "provider_error",
              detail: `Claude usage limit reached, resets_at ${now + 2400}`,
            },
          },
          "harness",
        ),
      );
      yield* harness.resume.observe(turnFailed(undefined, "harness"));

      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(1);
      expect(Date.parse(rows[0]?.runAt ?? "") / 1000).toBeGreaterThan(now + 2400);
    }),
  );

  effectIt.live("uses the tracked reset when nobody wrote a time down", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
        limitResetsAt: now + 7200,
      });

      yield* harness.resume.observe(turnFailed("usage limit reached"));

      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(1);
      expect(Date.parse(rows[0]?.runAt ?? "") / 1000).toBeGreaterThan(now + 7200);
    }),
  );

  effectIt.live("leaves ordinary failures alone", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
      });

      yield* harness.resume.observe(turnFailed("TypeError: cannot read property 'x' of undefined"));
      yield* harness.resume.observe(turnFailed("401 Unauthorized: invalid API key"));

      expect(yield* Ref.get(harness.scheduled)).toHaveLength(0);
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }),
  );

  effectIt.live("does not stack a second resume on a thread already waiting", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
        alreadyScheduled: [
          {
            id: ScheduledTurnId.make("scheduled-turn:existing"),
            threadId: THREAD,
            prompt: "Continue the work",
            origin: "usage-limit",
            runAt: "2026-08-05T05:00:00.000Z",
            status: "pending",
            createdAt: "2026-08-05T00:00:00.000Z",
            resolvedAt: null,
            error: null,
          },
        ],
      });

      yield* harness.resume.observe(turnFailed("usage limit reached"));

      expect(yield* Ref.get(harness.scheduled)).toHaveLength(1);
    }),
  );

  effectIt.live("retries a run that died on its own, and soon", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({ now, thread: threadDetail() });

      yield* harness.resume.observe(turnFailed("agent-harness exited with code 137 (SIGKILL)"));

      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.origin).toBe("auto-retry");

      // A crash names no reset time, so the wait is this service's own: short.
      const runAtSeconds = Date.parse(rows[0]?.runAt ?? "") / 1000;
      expect(runAtSeconds).toBeGreaterThanOrEqual(now + 55);
      expect(runAtSeconds).toBeLessThanOrEqual(now + 70);

      // And it says the honest thing about why, not "usage limit reached".
      const commands = yield* Ref.get(harness.commands);
      const activity = commands.find((command) => command.type === "thread.activity.append");
      expect(activity).toBeDefined();
      expect((activity as { activity: { kind: string; summary: string } }).activity.kind).toBe(
        "turn.auto-retry-scheduled",
      );
      expect((activity as { activity: { summary: string } }).activity.summary).toContain(
        "stopped unexpectedly",
      );
    }),
  );

  effectIt.live("backs off further each time the same thread falls over", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
        alreadyScheduled: [
          {
            id: ScheduledTurnId.make("scheduled-turn:retry-1"),
            threadId: THREAD,
            prompt: "Continue the work",
            origin: "auto-retry",
            runAt: DateTime.formatIso(DateTime.makeUnsafe((now - 600) * 1000)),
            status: "dispatched",
            createdAt: DateTime.formatIso(DateTime.makeUnsafe((now - 900) * 1000)),
            resolvedAt: null,
            error: null,
          },
        ],
      });

      yield* harness.resume.observe(turnFailed("read ECONNRESET"));

      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(2);
      // One retry already spent today, so this is the second: two minutes.
      const runAtSeconds = Date.parse(rows[1]?.runAt ?? "") / 1000;
      expect(runAtSeconds).toBeGreaterThanOrEqual(now + 115);
      expect(runAtSeconds).toBeLessThanOrEqual(now + 130);
    }),
  );

  effectIt.live("will not auto-retry an auth failure or a user's own Stop", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({ now, thread: threadDetail() });

      yield* harness.resume.observe(turnFailed("403 Forbidden: authentication failed"));
      yield* harness.resume.observe(turnFailed("Interrupted by user."));
      yield* harness.resume.observe(turnFailed("The turn was cancelled"));

      expect(yield* Ref.get(harness.scheduled)).toHaveLength(0);
      expect(yield* Ref.get(harness.commands)).toHaveLength(0);
    }),
  );

  effectIt.live("spends the crash budget without touching the usage-limit budget", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const spentRetries = [1, 2, 3].map((index) => ({
        id: ScheduledTurnId.make(`scheduled-turn:retry-${index}`),
        threadId: THREAD,
        prompt: "Continue the work",
        origin: "auto-retry" as const,
        runAt: DateTime.formatIso(DateTime.makeUnsafe((now - 600) * 1000)),
        status: "dispatched" as const,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe((now - 900) * 1000)),
        resolvedAt: null,
        error: null,
      }));
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
        alreadyScheduled: spentRetries,
      });

      // Three crashes today is the cap: a fourth is a broken job, not bad luck.
      yield* harness.resume.observe(turnFailed("socket hang up"));
      expect(yield* Ref.get(harness.scheduled)).toHaveLength(3);

      // But the window closing is a different problem with a different budget,
      // and a thread that crashed all evening has spent none of it.
      yield* harness.resume.observe(turnFailed("usage limit reached"));
      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(4);
      expect(rows[3]?.origin).toBe("usage-limit");
    }),
  );

  effectIt.live("stops at the crash cap but not before it", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const spentResumes = [1, 2, 3, 4, 5, 6].map((index) => ({
        id: ScheduledTurnId.make(`scheduled-turn:resume-${index}`),
        threadId: THREAD,
        prompt: "Continue the work",
        origin: "usage-limit" as const,
        runAt: DateTime.formatIso(DateTime.makeUnsafe((now - 600) * 1000)),
        status: "dispatched" as const,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe((now - 900) * 1000)),
        resolvedAt: null,
        error: null,
      }));
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
        alreadyScheduled: spentResumes,
      });

      // A night of legitimate waiting has not used up the crash allowance.
      yield* harness.resume.observe(turnFailed("fetch failed"));
      const rows = yield* Ref.get(harness.scheduled);
      expect(rows).toHaveLength(7);
      expect(rows[6]?.origin).toBe("auto-retry");
    }),
  );

  effectIt.live("T3CODE_AUTO_RETRY_ON_FAILURE=0 disables only the crash retries", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({ now, thread: threadDetail() });

      const previous = process.env.T3CODE_AUTO_RETRY_ON_FAILURE;
      process.env.T3CODE_AUTO_RETRY_ON_FAILURE = "0";
      try {
        yield* harness.resume.observe(turnFailed("agent-harness exited with code 1"));
        expect(yield* Ref.get(harness.scheduled)).toHaveLength(0);

        // The limit path is a separate promise and is not affected.
        yield* harness.resume.observe(turnFailed("usage limit reached"));
        const rows = yield* Ref.get(harness.scheduled);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.origin).toBe("usage-limit");
      } finally {
        if (previous === undefined) {
          delete process.env.T3CODE_AUTO_RETRY_ON_FAILURE;
        } else {
          process.env.T3CODE_AUTO_RETRY_ON_FAILURE = previous;
        }
      }
    }),
  );

  effectIt.live("forgets a previous turn's warnings when a new turn starts", () =>
    Effect.gen(function* () {
      const now = yield* nowSeconds;
      const harness = yield* makeHarness({
        now,
        thread: threadDetail(),
      });

      yield* harness.resume.observe(
        event({ type: "runtime.warning", payload: { message: "usage limit reached" } }),
      );
      yield* harness.resume.observe(event({ type: "turn.started", payload: {} }));
      yield* harness.resume.observe(turnFailed("the build failed"));

      expect(yield* Ref.get(harness.scheduled)).toHaveLength(0);
    }),
  );
});
