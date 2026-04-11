import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureAuthAccessManagementSchema, getAuthSessionColumns } from "./AuthSchema.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* ensureAuthAccessManagementSchema(sql);

  const sessionColumns = yield* getAuthSessionColumns(sql);

  if (!sessionColumns.some((column) => column.name === "last_connected_at")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN last_connected_at TEXT
    `;
  }
});
