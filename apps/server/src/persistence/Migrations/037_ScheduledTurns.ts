import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model_selection TEXT,
      run_at TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      error TEXT,
      command_id TEXT NOT NULL UNIQUE
    )
  `;

  // The dispatch loop asks exactly one question, every fifteen seconds:
  // which pending rows are due? This index is that question.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_turns_due
    ON scheduled_turns(status, run_at)
  `;
});
