import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      command_json TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS scheduled_turns_due
    ON scheduled_turns(status, next_attempt_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS scheduled_turns_thread
    ON scheduled_turns(thread_id, created_at DESC)
  `;
});
