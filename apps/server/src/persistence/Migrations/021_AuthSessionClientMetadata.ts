import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ensureAuthAccessManagementSchema,
  getAuthPairingLinkColumns,
  getAuthSessionColumns,
} from "./AuthSchema.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* ensureAuthAccessManagementSchema(sql);

  const pairingLinkColumns = yield* getAuthPairingLinkColumns(sql);
  if (!pairingLinkColumns.some((column) => column.name === "label")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN label TEXT
    `;
  }

  const sessionColumns = yield* getAuthSessionColumns(sql);

  if (!sessionColumns.some((column) => column.name === "client_label")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_label TEXT
    `;
  }

  if (!sessionColumns.some((column) => column.name === "client_ip_address")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_ip_address TEXT
    `;
  }

  if (!sessionColumns.some((column) => column.name === "client_user_agent")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_user_agent TEXT
    `;
  }

  if (!sessionColumns.some((column) => column.name === "client_device_type")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_device_type TEXT NOT NULL DEFAULT 'unknown'
    `;
  }

  if (!sessionColumns.some((column) => column.name === "client_os")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_os TEXT
    `;
  }

  if (!sessionColumns.some((column) => column.name === "client_browser")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN client_browser TEXT
    `;
  }
});
