import {
  ModelSelection,
  ScheduledTurn,
  ScheduledTurnId,
  ScheduledTurnOrigin,
  ScheduledTurnStatus,
  type ScheduleTurnInput,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Storage for turns that have been written down but not yet run.
 *
 * The table is the only durable record of a queued night of work, so every
 * transition it owns is expressed as a single SQL statement: a row is claimed,
 * failed, or cancelled atomically, never read-then-written. Two dispatch loop
 * iterations — or two servers — can race here and still fire the turn once.
 */

export class ScheduledTurnRepositoryError extends Schema.TaggedErrorClass<ScheduledTurnRepositoryError>()(
  "ScheduledTurnRepositoryError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? `Scheduled turn repository error in ${this.operation}`
      : `Scheduled turn repository error in ${this.operation}: ${this.detail}`;
  }
}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): ScheduledTurnRepositoryError =>
    new ScheduledTurnRepositoryError({ operation, cause });

/**
 * The row as SQLite hands it back: `model_selection` is a JSON blob, the
 * nullable columns are genuinely null rather than absent.
 */
const ScheduledTurnRow = Schema.Struct({
  id: ScheduledTurnId,
  threadId: ThreadId,
  prompt: Schema.String,
  origin: ScheduledTurnOrigin,
  modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  runAt: Schema.String,
  status: ScheduledTurnStatus,
  createdAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(TrimmedNonEmptyString),
});

const decodeScheduledTurnRow = Schema.decodeUnknownEffect(ScheduledTurnRow);
const encodeModelSelectionJson = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));

function toScheduledTurn(row: typeof ScheduledTurnRow.Type): ScheduledTurn {
  return {
    id: row.id,
    threadId: row.threadId,
    prompt: row.prompt,
    origin: row.origin,
    ...(row.modelSelection === null ? {} : { modelSelection: row.modelSelection }),
    runAt: row.runAt,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    error: row.error,
  } satisfies ScheduledTurn;
}

export class ScheduledTurnRepository extends Context.Service<
  ScheduledTurnRepository,
  {
    /**
     * Writes the turn down. Re-running the same `commandId` returns the row
     * that already exists instead of queueing the work twice.
     */
    readonly schedule: (
      input: ScheduleTurnInput,
    ) => Effect.Effect<ScheduledTurn, ScheduledTurnRepositoryError>;
    readonly listPending: () => Effect.Effect<
      ReadonlyArray<ScheduledTurn>,
      ScheduledTurnRepositoryError
    >;
    /** Pending plus recently resolved, newest first, capped for the UI. */
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<ScheduledTurn>,
      ScheduledTurnRepositoryError
    >;
    /**
     * Marks every due pending row `dispatched` and returns exactly the rows
     * this call took. A second caller sees none of them.
     */
    readonly claimDue: (
      nowIso: string,
    ) => Effect.Effect<ReadonlyArray<ScheduledTurn>, ScheduledTurnRepositoryError>;
    readonly markFailed: (
      id: ScheduledTurnId,
      error: string,
      atIso: string,
    ) => Effect.Effect<void, ScheduledTurnRepositoryError>;
    /** True only when a still-pending row was called off. */
    readonly cancel: (
      id: ScheduledTurnId,
      atIso: string,
    ) => Effect.Effect<boolean, ScheduledTurnRepositoryError>;
  }
>()("t3/persistence/ScheduledTurns/ScheduledTurnRepository") {}

/** Cap on `listAll`: enough history to explain last night, not a log reader. */
const LIST_ALL_LIMIT = 200;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const decodeRows = (operation: string) => (rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeScheduledTurnRow(row).pipe(
        Effect.mapError(toRepositoryError(operation)),
        Effect.map(toScheduledTurn),
      ),
    );

  const schedule: ScheduledTurnRepository["Service"]["schedule"] = (input) =>
    Effect.gen(function* () {
      // Deriving the id from the idempotency key keeps a retried request
      // pointing at the same row even before the unique index gets a say.
      const id = ScheduledTurnId.make(`scheduled-turn:${input.commandId}`);
      const modelSelectionJson =
        input.modelSelection === undefined
          ? null
          : yield* encodeModelSelectionJson(input.modelSelection).pipe(
              Effect.mapError(toRepositoryError("ScheduledTurnRepository.schedule:encode")),
            );
      const createdAt = DateTime.formatIso(yield* DateTime.now);

      const inserted = yield* sql`
        INSERT INTO scheduled_turns (
          id,
          thread_id,
          prompt,
          origin,
          model_selection,
          run_at,
          status,
          created_at,
          resolved_at,
          error,
          command_id
        )
        VALUES (
          ${id},
          ${input.threadId},
          ${input.prompt},
          ${input.origin ?? "user"},
          ${modelSelectionJson},
          ${input.runAt},
          'pending',
          ${createdAt},
          NULL,
          NULL,
          ${input.commandId}
        )
        ON CONFLICT(command_id) DO NOTHING
        RETURNING
          id AS "id",
          thread_id AS "threadId",
          prompt AS "prompt",
          origin AS "origin",
          model_selection AS "modelSelection",
          run_at AS "runAt",
          status AS "status",
          created_at AS "createdAt",
          resolved_at AS "resolvedAt",
          error AS "error"
      `.pipe(Effect.mapError(toRepositoryError("ScheduledTurnRepository.schedule:insert")));

      const rows =
        inserted.length > 0
          ? inserted
          : yield* sql`
              SELECT
                id AS "id",
                thread_id AS "threadId",
                prompt AS "prompt",
                origin AS "origin",
                model_selection AS "modelSelection",
                run_at AS "runAt",
                status AS "status",
                created_at AS "createdAt",
                resolved_at AS "resolvedAt",
                error AS "error"
              FROM scheduled_turns
              WHERE command_id = ${input.commandId}
            `.pipe(Effect.mapError(toRepositoryError("ScheduledTurnRepository.schedule:select")));

      const decoded = yield* decodeRows("ScheduledTurnRepository.schedule:decodeRow")(rows);
      const existing = decoded[0];
      if (existing === undefined) {
        return yield* Effect.fail(
          new ScheduledTurnRepositoryError({
            operation: "ScheduledTurnRepository.schedule",
            detail: "insert returned no row and no row exists for the command id",
          }),
        );
      }
      return existing;
    });

  const listPending: ScheduledTurnRepository["Service"]["listPending"] = () =>
    sql`
      SELECT
        id AS "id",
        thread_id AS "threadId",
        prompt AS "prompt",
        origin AS "origin",
        model_selection AS "modelSelection",
        run_at AS "runAt",
        status AS "status",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt",
        error AS "error"
      FROM scheduled_turns
      WHERE status = 'pending'
      ORDER BY run_at ASC, id ASC
    `.pipe(
      Effect.mapError(toRepositoryError("ScheduledTurnRepository.listPending:query")),
      Effect.flatMap(decodeRows("ScheduledTurnRepository.listPending:decodeRows")),
    );

  const listAll: ScheduledTurnRepository["Service"]["listAll"] = () =>
    sql`
      SELECT
        id AS "id",
        thread_id AS "threadId",
        prompt AS "prompt",
        origin AS "origin",
        model_selection AS "modelSelection",
        run_at AS "runAt",
        status AS "status",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt",
        error AS "error"
      FROM scheduled_turns
      ORDER BY created_at DESC, id DESC
      LIMIT ${LIST_ALL_LIMIT}
    `.pipe(
      Effect.mapError(toRepositoryError("ScheduledTurnRepository.listAll:query")),
      Effect.flatMap(decodeRows("ScheduledTurnRepository.listAll:decodeRows")),
    );

  /**
   * One statement does the selecting and the claiming, so the window in which
   * a row is both due and unclaimed never spans two queries. A concurrent
   * caller either sees the row as `pending` and takes it, or sees it as
   * `dispatched` and matches nothing.
   */
  const claimDue: ScheduledTurnRepository["Service"]["claimDue"] = (nowIso) =>
    sql`
      UPDATE scheduled_turns
      SET status = 'dispatched',
          resolved_at = ${nowIso}
      WHERE id IN (
        SELECT id
        FROM scheduled_turns
        WHERE status = 'pending'
          AND run_at <= ${nowIso}
      )
      RETURNING
        id AS "id",
        thread_id AS "threadId",
        prompt AS "prompt",
        origin AS "origin",
        model_selection AS "modelSelection",
        run_at AS "runAt",
        status AS "status",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt",
        error AS "error"
    `.pipe(
      Effect.mapError(toRepositoryError("ScheduledTurnRepository.claimDue:query")),
      Effect.flatMap(decodeRows("ScheduledTurnRepository.claimDue:decodeRows")),
      Effect.map((turns) =>
        [...turns].sort((left, right) => left.runAt.localeCompare(right.runAt)),
      ),
    );

  const markFailed: ScheduledTurnRepository["Service"]["markFailed"] = (id, error, atIso) =>
    sql`
      UPDATE scheduled_turns
      SET status = 'failed',
          error = ${error},
          resolved_at = ${atIso}
      WHERE id = ${id}
    `.pipe(
      Effect.mapError(toRepositoryError("ScheduledTurnRepository.markFailed:query")),
      Effect.asVoid,
    );

  const cancel: ScheduledTurnRepository["Service"]["cancel"] = (id, atIso) =>
    sql`
      UPDATE scheduled_turns
      SET status = 'cancelled',
          resolved_at = ${atIso}
      WHERE id = ${id}
        AND status = 'pending'
      RETURNING id AS "id"
    `.pipe(
      Effect.mapError(toRepositoryError("ScheduledTurnRepository.cancel:query")),
      Effect.map((rows) => rows.length > 0),
    );

  return {
    schedule,
    listPending,
    listAll,
    claimDue,
    markFailed,
    cancel,
  } satisfies ScheduledTurnRepository["Service"];
});

export const layer = Layer.effect(ScheduledTurnRepository, make);
