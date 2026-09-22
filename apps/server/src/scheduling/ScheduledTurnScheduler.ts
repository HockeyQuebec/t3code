import {
  type CancelScheduledTurnInput,
  type CancelScheduledTurnResult,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ScheduledTurn,
  type ScheduledTurnList,
  type ScheduleTurnInput,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ScheduledTurnRepository,
  type ScheduledTurnRepositoryError,
} from "../persistence/ScheduledTurns.ts";
import { subscribeBeforeSnapshot } from "../utils/subscribeBeforeSnapshot.ts";

/**
 * Turns queued for later, and the fiber that eventually runs them.
 *
 * The queue lives in SQLite, not in this process: nothing here holds a timer
 * per scheduled turn, so a restart between "queue it" and "run it" costs
 * nothing. A poll every fifteen seconds asks the table for whatever is due,
 * which makes the worst-case lateness fifteen seconds — irrelevant for work
 * queued for tonight, and far cheaper than reconstructing timers on boot.
 */

/** How often the dispatch fiber asks the table what is due. */
const POLL_INTERVAL = Duration.seconds(15);

export class ScheduledTurnScheduler extends Context.Service<
  ScheduledTurnScheduler,
  {
    readonly schedule: (
      input: ScheduleTurnInput,
    ) => Effect.Effect<ScheduledTurn, ScheduledTurnRepositoryError>;
    readonly cancel: (
      input: CancelScheduledTurnInput,
    ) => Effect.Effect<CancelScheduledTurnResult, ScheduledTurnRepositoryError>;
    readonly latest: Effect.Effect<ScheduledTurnList, ScheduledTurnRepositoryError>;
    readonly changes: Stream.Stream<ScheduledTurnList>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: ScheduledTurnList;
        readonly changes: Stream.Stream<ScheduledTurnList>;
      },
      ScheduledTurnRepositoryError,
      Scope.Scope
    >;
    /**
     * One pass of the dispatch loop: claim what is due and run it. The forked
     * fiber calls this on a timer; tests call it directly so they never have
     * to wait on a clock.
     */
    readonly runDuePass: Effect.Effect<void, ScheduledTurnRepositoryError>;
  }
>()("t3/scheduling/ScheduledTurnScheduler") {}

/**
 * A dispatch failure has to reach the user as text in the row, and
 * `ScheduledTurn.error` rejects blank strings — so an error that describes
 * itself as nothing still gets a sentence.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  const rendered = String(error).trim();
  return rendered.length > 0 ? rendered : "Dispatch failed";
}

/** Ids only have to be unique, not unguessable — these name a local command. */
const nextIdSuffix = Effect.map(Random.nextInt, (value) => Math.abs(value).toString(36));

export const make = Effect.gen(function* () {
  const repository = yield* ScheduledTurnRepository;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const changes = yield* PubSub.unbounded<ScheduledTurnList>();
  const mutex = yield* Semaphore.make(1);

  const buildList = Effect.gen(function* () {
    const readAt = yield* DateTime.now;
    const scheduled = yield* repository.listAll();
    return {
      readAt,
      // The contract promises soonest first; the table hands back newest
      // first because that is the cheap index for the history cap.
      scheduled: [...scheduled].sort((left, right) => left.runAt.localeCompare(right.runAt)),
    } satisfies ScheduledTurnList;
  });

  const publish = Effect.flatMap(buildList, (list) => PubSub.publish(changes, list));

  /**
   * The model a queued turn should actually run on.
   *
   * A row remembers the model that was selected when it was queued, which is
   * the right answer only while the thread has not started talking to a
   * provider yet. Once a session exists, the thread is bound to it: replaying
   * the old selection asks for a mid-conversation model change, which some
   * providers refuse outright — the turn is then rejected downstream, and
   * because the row was already claimed it reports itself as dispatched while
   * nothing runs. A queued follow-up behaves like any other follow-up and
   * takes the session's model, so `undefined` here means "whatever this thread
   * is already using".
   */
  const resolveModelSelection = Effect.fnUntraced(function* (turn: ScheduledTurn) {
    if (turn.modelSelection === undefined) {
      return undefined;
    }
    const thread = yield* projection.getThreadDetailById(turn.threadId).pipe(
      Effect.map(Option.getOrUndefined),
      // A thread we cannot read is a thread we cannot reason about. Sending the
      // remembered selection is what this row asked for, and the dispatch that
      // follows reports any real problem.
      Effect.orElseSucceed(() => undefined),
    );
    const hasStartedSession = thread?.session != null && thread.session.status !== "stopped";
    return hasStartedSession ? undefined : turn.modelSelection;
  });

  const dispatchOne = Effect.fn("scheduledTurns.dispatch")(function* (
    turn: ScheduledTurn,
    nowIso: string,
  ) {
    const suffix = yield* nextIdSuffix;
    const modelSelection = yield* resolveModelSelection(turn);
    const command = {
      type: "thread.turn.start",
      commandId: CommandId.make(`scheduled:${turn.id}:${suffix}`),
      threadId: turn.threadId,
      message: {
        messageId: MessageId.make(`scheduled-message:${turn.id}:${suffix}`),
        role: "user",
        text: turn.prompt,
        attachments: [],
      },
      ...(modelSelection === undefined ? {} : { modelSelection }),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: nowIso,
    } satisfies typeof ThreadTurnStartCommand.Type;

    // The row was already claimed, so a failure here ends its life as
    // `failed` with a reason. Nothing re-queues it: a turn that could not
    // start must say so rather than retry against the same broken thread.
    yield* engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        repository
          .markFailed(turn.id, describeFailure(error), nowIso)
          .pipe(Effect.catchCause((cause) => Effect.logError("scheduledTurns.markFailed", cause))),
      ),
    );
  });

  const runDuePass = Effect.gen(function* () {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const claimed = yield* repository.claimDue(nowIso);
    if (claimed.length === 0) {
      return;
    }
    yield* Effect.forEach(claimed, (turn) => dispatchOne(turn, nowIso), { discard: true });
    yield* publish;
  });

  const schedule: ScheduledTurnScheduler["Service"]["schedule"] = (input) =>
    repository.schedule(input).pipe(Effect.tap(() => publish));

  const cancel: ScheduledTurnScheduler["Service"]["cancel"] = (input) =>
    Effect.gen(function* () {
      const atIso = DateTime.formatIso(yield* DateTime.now);
      const cancelled = yield* repository.cancel(input.id, atIso);
      if (cancelled) {
        yield* publish;
      }
      return { cancelled } satisfies CancelScheduledTurnResult;
    });

  // Sleeping first keeps layer construction cheap and lets anything overdue
  // from before a restart wait one interval rather than racing startup.
  yield* Effect.sleep(POLL_INTERVAL).pipe(
    Effect.andThen(
      runDuePass.pipe(
        Effect.catchCause((cause) => Effect.logError("scheduledTurns.dispatchLoop", cause)),
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  return {
    schedule,
    cancel,
    latest: buildList,
    changes: Stream.fromPubSub(changes),
    subscribe: subscribeBeforeSnapshot(changes, buildList, mutex),
    runDuePass,
  } satisfies ScheduledTurnScheduler["Service"];
});

export const layer = Layer.effect(ScheduledTurnScheduler, make);
