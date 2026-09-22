import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Who queued a scheduled turn.
 *
 * Rows written before automatic resumes existed were all queued by a person,
 * which is exactly what the default says — so the backfill is the default and
 * there is nothing to rewrite.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(scheduled_turns)
  `;

  if (!columns.some((column) => column.name === "origin")) {
    yield* sql`
      ALTER TABLE scheduled_turns
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
    `;
  }

  // "Has this thread already got a resume queued?" is asked once per failed
  // turn, and the automatic resumes are a small minority of the table.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_turns_origin_thread
    ON scheduled_turns(origin, thread_id)
  `;
});
