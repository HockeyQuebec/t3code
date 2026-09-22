import {
  CommandId,
  EventId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ScheduledTurn,
  type ThreadId,
} from "@t3tools/contracts";
import {
  AUTO_RETRY_ORIGIN,
  buildResumePrompt,
  classifyTurnFailure,
  extractOriginalTask,
  mayQueueResume,
  resolveResumeAt,
  resolveTransientRetryAt,
  type ResumeKind,
  type TurnFailureClass,
  USAGE_LIMIT_ORIGIN,
} from "@t3tools/shared/usageLimitResume";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { AgentLimits } from "../agentLimits/AgentLimits.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HARNESS_DRIVER_KIND } from "../provider/Layers/HarnessAdapter.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ScheduledTurnScheduler } from "./ScheduledTurnScheduler.ts";

/**
 * Carrying interrupted work across a usage limit.
 *
 * A subscription running out does not mean the job was wrong, only that it is
 * early. This watches the provider event stream for a turn that died because a
 * limit was reached, works out when that window reopens, and writes the work
 * down as a scheduled turn for just after — so a night of work that hits a
 * five-hour wall at 1am carries on at 6am instead of being found dead in the
 * morning.
 *
 * Two kinds of work resume differently, and the difference is the whole design:
 *
 *   - A conversational provider keeps its session. The thread still holds the
 *     conversation, so the resumed turn is a nudge to carry on.
 *   - Agent Harness keeps nothing. One turn is one `agent-harness run` process
 *     driving a whole workflow in a worktree, and when that process dies the
 *     run is gone — no session, no cursor, nothing to continue. Resuming it
 *     means invoking the workflow again with the same task, the same workflow
 *     (which lives in the thread's model selection, so it must be passed
 *     through explicitly), and a note saying where the dead run left its
 *     partial work so the new one builds on it instead of starting over.
 *
 * A limit is not the only way an unattended night dies, though, and the rest of
 * the ways look nothing like it: the harness process is OOM-killed, a socket
 * drops mid-stream, the provider returns 529 for ninety seconds. None of those
 * are the job's fault either, and all of them are answered by trying again in a
 * minute rather than by leaving the work dead until morning. So a failed turn
 * is classified rather than merely matched — `usage-limit` waits for the window
 * and `transient` backs off exponentially, while everything else, including
 * everything unrecognised and every user-pressed Stop, is left alone. The
 * asymmetry is deliberate: a missed retry costs one re-send by hand, and a
 * wrong retry costs a night of the same failure re-sending itself.
 *
 * Note on `turn.aborted`: it is not hooked. Both an interrupted request and a
 * user pressing Stop surface as `turn.aborted` with a free-text `reason` and no
 * structural difference between them (see `OpenCodeAdapter`, which emits it for
 * a request error and for `interruptTurn` alike), and guessing wrong in that
 * direction means restarting work somebody deliberately stopped. A crash that
 * genuinely kills a run still arrives here as `turn.completed` with a failed
 * state, which is the path this service acts on.
 *
 * Detection has the same split. A conversational provider names the limit in
 * the turn's own failure message. The harness reports its failing *step*, whose
 * error is often just an exit code — the provider's actual sentence about the
 * limit was written by the agent inside that step, and reaches this service as
 * a `runtime.warning`. So warnings seen during a turn are kept and consulted
 * when the turn fails, which is what makes this work for harness runs at all.
 */

/** Never re-send sooner than this, whatever the provider claims. */
const MINIMUM_DELAY_SECONDS = 120;
/** Used when neither the failure text nor the limit tracker knows the reset. */
const FALLBACK_DELAY_SECONDS = 30 * 60;
/** Automatic resumes one thread may get in a rolling day before this gives up. */
const MAX_RESUMES_PER_DAY = 6;
/**
 * Automatic crash-retries one thread may get in a rolling day.
 *
 * Lower than the usage-limit allowance, and for the opposite reason. A usage
 * limit is a known, self-clearing pause, so waiting through six of them in a
 * night is a night working as designed. A crash is an unknown, and a run that
 * crashes three times in a row is almost never a run that will succeed on the
 * fourth — it is a broken tool, a missing dependency, or a genuinely impossible
 * task, and the useful thing to do at that point is stop and leave the failures
 * visible for whoever comes back in the morning.
 *
 * Counted separately from the resume budget: a thread that waited out six
 * windows still gets its three crash-retries, and vice versa.
 */
const MAX_AUTO_RETRIES_PER_DAY = 3;
/** Warnings kept per thread while a turn runs. A limit is announced once. */
const MAX_BUFFERED_WARNINGS = 16;
/** Enough of a warning to match a pattern and parse a reset time out of. */
const MAX_WARNING_CHARS = 4_000;
/** Threads tracked at once, so a long-lived server cannot grow this forever. */
const MAX_TRACKED_THREADS = 256;

/**
 * Set `T3CODE_AUTO_RESUME_ON_USAGE_LIMIT=0` to keep failed turns failed. The
 * feature sends prompts nobody typed, hours later, so there has to be a way to
 * turn it off without editing settings the server may not have loaded yet.
 */
function autoResumeEnabled(): boolean {
  return process.env.T3CODE_AUTO_RESUME_ON_USAGE_LIMIT !== "0";
}

/**
 * Set `T3CODE_AUTO_RETRY_ON_FAILURE=0` to keep crashed turns crashed while
 * still resuming after usage limits.
 *
 * There are two switches rather than one because the two behaviours have
 * different risk profiles and different people object to them. Resuming after a
 * limit is a wait for something everyone agrees will happen; retrying a crash
 * is a guess that the failure was environmental, and a guess made against a
 * task with side effects — one that pushes, deploys, or opens a PR — is a guess
 * someone may reasonably want to switch off on its own, without also losing the
 * limit handling that makes overnight work possible at all. The usage-limit
 * switch remains the master: turning it off stops both, because it turns off
 * the service's willingness to send anything nobody typed.
 */
function autoRetryEnabled(): boolean {
  return process.env.T3CODE_AUTO_RETRY_ON_FAILURE !== "0";
}

/** How long a scheduled row stays countable as "one of today's attempts". */
const DAY_MILLIS = 24 * 60 * 60 * 1000;

export class UsageLimitResume extends Context.Service<
  UsageLimitResume,
  {
    /**
     * Feed one provider event in. The forked subscription calls this for every
     * event; tests call it directly with the sequence a real run produces.
     */
    readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  }
>()("t3/scheduling/UsageLimitResume") {}

/** What a thread's in-flight turn has told us that its failure might need. */
interface ThreadTrace {
  /** Error-ish text seen during the turn, newest last. */
  readonly warnings: ReadonlyArray<string>;
  /** The worktree a harness run reported, when it got that far. */
  readonly workspace: string | null;
  /** The workflow node a harness run died on. */
  readonly failedStep: string | null;
}

const EMPTY_TRACE: ThreadTrace = { warnings: [], workspace: null, failedStep: null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Text worth keeping from an event, or null.
 *
 * Only failure-shaped events qualify. Keeping ordinary assistant prose would
 * mean an agent that merely *wrote about* rate limits could later be mistaken
 * for one that hit one.
 */
function failureTextFromEvent(event: ProviderRuntimeEvent): string | null {
  switch (event.type) {
    case "runtime.warning":
      return asNonEmptyString(event.payload.message);
    case "runtime.error": {
      // When the harness process dies outright the message is only an exit
      // code — the provider's sentence about the limit is in the captured
      // stderr, so the two are read together.
      const detail = asNonEmptyString(event.payload.detail);
      const message = asNonEmptyString(event.payload.message);
      if (message === null) {
        return detail;
      }
      return detail === null ? message : `${message}\n${detail}`;
    }
    case "session.state.changed":
      return event.payload.state === "error" ? asNonEmptyString(event.payload.reason) : null;
    case "session.exited":
      return asNonEmptyString(event.payload.reason);
    case "item.completed": {
      if (event.payload.status !== "failed") {
        return null;
      }
      const data = asRecord(event.payload.data);
      return asNonEmptyString(data?.error) ?? asNonEmptyString(event.payload.detail);
    }
    default:
      return null;
  }
}

/** The harness names its worktree in the summary item it ends a run with. */
function workspaceFromEvent(event: ProviderRuntimeEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }
  return asNonEmptyString(asRecord(event.payload.data)?.workspace);
}

/** The workflow node a failed harness step belongs to. */
function failedStepFromEvent(event: ProviderRuntimeEvent): string | null {
  if (event.type !== "item.completed" || event.payload.status !== "failed") {
    return null;
  }
  return asNonEmptyString(asRecord(event.payload.data)?.node);
}

function truncate(text: string): string {
  return text.length <= MAX_WARNING_CHARS ? text : text.slice(0, MAX_WARNING_CHARS);
}

export const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const scheduler = yield* ScheduledTurnScheduler;
  const agentLimits = yield* AgentLimits;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;

  const traces = yield* Ref.make<ReadonlyMap<ThreadId, ThreadTrace>>(new Map());

  const updateTrace = (threadId: ThreadId, update: (trace: ThreadTrace) => ThreadTrace) =>
    Ref.update(traces, (current) => {
      const next = new Map(current);
      next.set(threadId, update(current.get(threadId) ?? EMPTY_TRACE));
      // Oldest insertion first, so dropping from the front sheds the threads
      // least likely to still be running.
      while (next.size > MAX_TRACKED_THREADS) {
        const oldest = next.keys().next();
        if (oldest.done === true) {
          break;
        }
        next.delete(oldest.value);
      }
      return next;
    });

  const clearTrace = (threadId: ThreadId) =>
    Ref.update(traces, (current) => {
      if (!current.has(threadId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  /**
   * When the failed provider's binding window reopens, in unix seconds.
   *
   * Read from the same telemetry the header shows, matched on the instance
   * first because limits are metered per subscription — two Claude accounts
   * configured separately do not share a window.
   */
  const trackedResetSeconds = (event: ProviderRuntimeEvent) =>
    Effect.map(agentLimits.latest, (snapshot) => {
      const row =
        snapshot.providers.find((candidate) => candidate.instanceId === event.providerInstanceId) ??
        snapshot.providers.find((candidate) => candidate.driver === event.provider);
      if (row === undefined) {
        return null;
      }
      const binding = Option.getOrUndefined(row.binding);
      const resetsAt = binding === undefined ? undefined : Option.getOrUndefined(binding.resetsAt);
      return resetsAt === undefined ? null : DateTime.toEpochMillis(resetsAt) / 1000;
    });

  /**
   * The prompt to re-send, and the model to re-send it with.
   *
   * Null means the work cannot be described well enough to resume — a harness
   * job whose task text is gone, or a thread that no longer exists — and a
   * resume nobody can act on is worse than a failure someone can see.
   */
  const describeResume = Effect.fn("usageLimitResume.describeResume")(function* (input: {
    readonly threadId: ThreadId;
    readonly kind: ResumeKind;
    readonly failure: TurnFailureClass;
    readonly trace: ThreadTrace;
  }) {
    const thread = yield* projection.getThreadDetailById(input.threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (thread === undefined) {
      return null;
    }

    // The task a batch run was given is the last thing the user actually sent.
    // `extractOriginalTask` unwraps it when that message was itself a resume,
    // so a job interrupted twice does not accumulate preambles.
    const lastUserMessage = thread.messages.findLast(
      (message) => message.role === "user" && (message.text ?? "").trim().length > 0,
    );
    const originalTask =
      lastUserMessage === undefined ? null : extractOriginalTask(lastUserMessage.text ?? "");

    const prompt = buildResumePrompt({
      kind: input.kind,
      reason: input.failure,
      originalTask,
      workspace: input.trace.workspace ?? thread.worktreePath,
      failedStep: input.trace.failedStep,
    });
    if (prompt === null) {
      return null;
    }

    return { prompt, modelSelection: thread.modelSelection as ModelSelection };
  });

  /**
   * Say so on the thread, so the wait is visible where the failure is.
   *
   * The wording is not cosmetic. Someone reading the thread in the morning has
   * to be able to tell "your subscription ran out and this is waiting for it to
   * come back" from "this fell over and is being tried again", because the
   * first needs no action and the second may well need theirs. `kind` is an
   * open string in the activity schema (`OrchestrationThreadActivity.kind` is a
   * `TrimmedNonEmptyString`), so a new value needs no contract change.
   */
  const announce = Effect.fn("usageLimitResume.announce")(function* (input: {
    readonly threadId: ThreadId;
    readonly failure: TurnFailureClass;
    readonly scheduled: ScheduledTurn;
    readonly createdAt: string;
  }) {
    const usageLimit = input.failure === "usage-limit";
    const prefix = usageLimit ? "usage-limit-resume" : "auto-retry";
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`${prefix}-activity:${input.scheduled.id}`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(`${prefix}:${input.scheduled.id}`),
          tone: "info",
          kind: usageLimit ? "usage-limit.resume-scheduled" : "turn.auto-retry-scheduled",
          summary: usageLimit
            ? "Usage limit reached — this work is queued to resume"
            : "The run stopped unexpectedly — retrying shortly",
          payload: {
            runAt: input.scheduled.runAt,
            scheduledTurnId: input.scheduled.id,
          },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.ignore);
  });

  const handleFailedTurn = Effect.fn("usageLimitResume.handleFailedTurn")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const trace = (yield* Ref.get(traces)).get(event.threadId) ?? EMPTY_TRACE;

    // The turn's own message first: when a conversational provider says it, it
    // is the most direct account of what stopped this turn. Warnings are read
    // newest first because a harness step's last words are the ones that
    // killed it.
    const candidates = [event.payload.errorMessage, ...trace.warnings.toReversed()].filter(
      (text): text is string => typeof text === "string",
    );

    // Every candidate is classified rather than stopping at the first match,
    // because the two answers are not equally informative. A harness run that
    // hit a limit reports *both*: the step's own last words are an exit code
    // (transient), and the sentence explaining why it exited is a limit, buried
    // further back. The limit is the real explanation, so it wins wherever it
    // appears; a transient reading is only used when nothing said "limit".
    // Anything classified `permanent` is skipped outright — it is neither an
    // explanation worth acting on nor a veto over a better one further down.
    let matched: { readonly text: string; readonly failure: TurnFailureClass } | undefined;
    for (const candidate of candidates) {
      const failure = classifyTurnFailure(candidate);
      if (failure === "usage-limit") {
        matched = { text: candidate, failure };
        break;
      }
      if (failure === "transient" && matched === undefined) {
        matched = { text: candidate, failure };
      }
    }
    if (matched === undefined) {
      return;
    }

    // The second kill switch only covers crash-retries; a limit resume is still
    // allowed to run when it is off.
    if (matched.failure === "transient" && !autoRetryEnabled()) {
      return;
    }

    const now = yield* DateTime.now;
    const nowMillis = DateTime.toEpochMillis(now);

    const queued = yield* scheduler.latest.pipe(Effect.orElseSucceed(() => null));
    if (queued === null) {
      yield* Effect.logWarning("usageLimitResume could not read the schedule", {
        threadId: event.threadId,
      });
      return;
    }
    const usageLimit = matched.failure === "usage-limit";
    const origin = usageLimit ? USAGE_LIMIT_ORIGIN : AUTO_RETRY_ORIGIN;
    if (
      !mayQueueResume({
        threadId: event.threadId,
        queued: queued.scheduled,
        nowMillis,
        origin,
        maxPerDay: usageLimit ? MAX_RESUMES_PER_DAY : MAX_AUTO_RETRIES_PER_DAY,
      })
    ) {
      yield* Effect.logInfo("usageLimitResume declined to queue another resume", {
        threadId: event.threadId,
        origin,
        reason: "something automatic is already pending, or this origin's daily cap is spent",
      });
      return;
    }

    // How many crash-retries this thread has already had today, which is what
    // the backoff grows against. Counted from the schedule rather than kept in
    // memory so a server restart mid-night does not reset the sequence back to
    // one minute and start the hammering over again.
    const priorAutoRetries = queued.scheduled.filter((row) => {
      if (row.threadId !== event.threadId || row.origin !== AUTO_RETRY_ORIGIN) {
        return false;
      }
      const created = Date.parse(row.createdAt);
      return Number.isNaN(created) || created >= nowMillis - DAY_MILLIS;
    }).length;

    const nowSeconds = nowMillis / 1000;
    const resumeAt = usageLimit
      ? resolveResumeAt({
          failureText: matched.text,
          limitResetsAtSeconds: yield* trackedResetSeconds(event),
          nowSeconds,
          minimumDelaySeconds: MINIMUM_DELAY_SECONDS,
          fallbackDelaySeconds: FALLBACK_DELAY_SECONDS,
        })
      : {
          ...resolveTransientRetryAt({ attempt: priorAutoRetries + 1, nowSeconds }),
          // A crash names no reset time and the limit tracker has nothing to
          // say about it, so the delay is entirely this service's own decision.
          source: "fallback" as const,
        };

    const kind: ResumeKind = event.provider === HARNESS_DRIVER_KIND ? "batch" : "conversation";
    const described = yield* describeResume({
      threadId: event.threadId,
      kind,
      failure: matched.failure,
      trace,
    });
    if (described === null) {
      yield* Effect.logWarning("usageLimitResume found nothing it could re-send", {
        threadId: event.threadId,
        kind,
      });
      return;
    }

    const runAt = DateTime.formatIso(DateTime.makeUnsafe(resumeAt.atSeconds * 1000));
    const scheduled = yield* scheduler
      .schedule({
        threadId: event.threadId,
        prompt: described.prompt,
        origin,
        modelSelection: described.modelSelection,
        runAt,
        // Deterministic, so the same interrupted turn cannot be queued twice —
        // by a duplicated event, or by a second pass over the same stream. The
        // two paths use different prefixes so a turn that is first read as a
        // crash and later as a limit (or the reverse, across a restart) does
        // not have one silently swallowed by the other's idempotency key.
        commandId: CommandId.make(
          `${usageLimit ? "usage-limit-resume" : "auto-retry"}:${event.threadId}:${event.turnId ?? event.eventId}`,
        ),
      })
      .pipe(
        Effect.asSome,
        Effect.orElseSucceed(() => Option.none<ScheduledTurn>()),
      );

    if (Option.isNone(scheduled)) {
      yield* Effect.logWarning("usageLimitResume failed to queue the resumed turn", {
        threadId: event.threadId,
        runAt,
      });
      return;
    }

    yield* Effect.logInfo("usageLimitResume queued interrupted work", {
      threadId: event.threadId,
      provider: event.provider,
      kind,
      failure: matched.failure,
      origin,
      attempt: usageLimit ? undefined : priorAutoRetries + 1,
      runAt,
      resumeAtSource: resumeAt.source,
    });
    yield* announce({
      threadId: event.threadId,
      failure: matched.failure,
      scheduled: scheduled.value,
      createdAt: DateTime.formatIso(now),
    });
  });

  const observe: UsageLimitResume["Service"]["observe"] = (event) =>
    Effect.gen(function* () {
      if (!autoResumeEnabled()) {
        return;
      }

      // A new turn is a new account of what is happening: nothing the last one
      // said should be able to explain this one's failure.
      if (event.type === "turn.started") {
        yield* clearTrace(event.threadId);
        return;
      }

      const workspace = workspaceFromEvent(event);
      const failedStep = failedStepFromEvent(event);
      const failureText = failureTextFromEvent(event);
      if (workspace !== null || failedStep !== null || failureText !== null) {
        yield* updateTrace(event.threadId, (trace) => ({
          workspace: workspace ?? trace.workspace,
          failedStep: failedStep ?? trace.failedStep,
          warnings:
            failureText === null
              ? trace.warnings
              : [...trace.warnings, truncate(failureText)].slice(-MAX_BUFFERED_WARNINGS),
        }));
      }

      if (event.type === "turn.completed") {
        if (event.payload.state === "failed") {
          yield* handleFailedTurn(event);
        }
        yield* clearTrace(event.threadId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("usageLimitResume failed to process an event", {
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  yield* providerService.streamEvents.pipe(Stream.runForEach(observe), Effect.forkScoped);

  return { observe } satisfies UsageLimitResume["Service"];
});

export const layer = Layer.effect(UsageLimitResume, make);
