import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_queued_followups (
      queued_followup_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      model_selection_json TEXT,
      interaction_mode TEXT NOT NULL,
      source_proposed_plan_thread_id TEXT,
      source_proposed_plan_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_queued_followups_thread_created
    ON projection_thread_queued_followups(thread_id, created_at)
  `;
});
