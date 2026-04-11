import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const freshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const getColumnNames = (tableName: "auth_pairing_links" | "auth_sessions") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns =
      tableName === "auth_pairing_links"
        ? yield* sql<{ readonly name: string }>`
            PRAGMA table_info(auth_pairing_links)
          `
        : yield* sql<{ readonly name: string }>`
            PRAGMA table_info(auth_sessions)
          `;

    return columns.map((column) => column.name);
  });

freshLayer("020_AuthAccessManagement", (it) => {
  it.effect("creates the auth schema and follow-up columns on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed.slice(19), [
        [20, "AuthAccessManagement"],
        [21, "AuthSessionClientMetadata"],
        [22, "AuthSessionLastConnectedAt"],
        [23, "ProjectionThreadQueuedFollowups"],
      ]);

      const authTables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('auth_pairing_links', 'auth_sessions', 'projection_thread_queued_followups')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        authTables.map((table) => table.name),
        ["auth_pairing_links", "auth_sessions", "projection_thread_queued_followups"],
      );

      const pairingLinkColumns = yield* getColumnNames("auth_pairing_links");
      assert.deepStrictEqual(pairingLinkColumns, [
        "id",
        "credential",
        "method",
        "role",
        "subject",
        "created_at",
        "expires_at",
        "consumed_at",
        "revoked_at",
        "label",
      ]);

      const sessionColumns = yield* getColumnNames("auth_sessions");
      assert.deepStrictEqual(sessionColumns, [
        "session_id",
        "subject",
        "role",
        "method",
        "issued_at",
        "expires_at",
        "revoked_at",
        "client_label",
        "client_ip_address",
        "client_user_agent",
        "client_device_type",
        "client_os",
        "client_browser",
        "last_connected_at",
      ]);

      const pairingLinkIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(auth_pairing_links)
      `;
      assert.ok(pairingLinkIndexes.some((index) => index.name === "idx_auth_pairing_links_active"));

      const sessionIndexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(auth_sessions)
      `;
      assert.ok(sessionIndexes.some((index) => index.name === "idx_auth_sessions_active"));
    }),
  );
});

legacyLayer("020_AuthAccessManagement compatibility", (it) => {
  it.effect("repairs auth schema for a legacy database that already recorded migration 20", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 19 });

      yield* sql`
        CREATE TABLE projection_thread_queued_followups (
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
        INSERT INTO projection_thread_queued_followups (
          queued_followup_id,
          thread_id,
          message_id,
          text,
          attachments_json,
          model_selection_json,
          interaction_mode,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          created_at,
          updated_at
        )
        VALUES (
          'followup-1',
          'thread-1',
          'message-1',
          'follow up later',
          '[]',
          NULL,
          'default',
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (20, 'ProjectionThreadQueuedFollowups')
      `;

      const preRepairAuthTables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('auth_pairing_links', 'auth_sessions')
        ORDER BY name
      `;
      assert.deepStrictEqual(preRepairAuthTables, []);

      const executed = yield* runMigrations();

      assert.deepStrictEqual(executed, [
        [21, "AuthSessionClientMetadata"],
        [22, "AuthSessionLastConnectedAt"],
        [23, "ProjectionThreadQueuedFollowups"],
      ]);

      const pairingLinkColumns = yield* getColumnNames("auth_pairing_links");
      assert.ok(pairingLinkColumns.includes("label"));

      const sessionColumns = yield* getColumnNames("auth_sessions");
      assert.ok(sessionColumns.includes("client_device_type"));
      assert.ok(sessionColumns.includes("last_connected_at"));

      const queuedFollowupCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_thread_queued_followups
      `;
      assert.deepStrictEqual(queuedFollowupCount, [{ count: 1 }]);

      const recordedMigrations = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT
          migration_id AS "migrationId",
          name
        FROM effect_sql_migrations
        WHERE migration_id >= 20
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(recordedMigrations, [
        { migrationId: 20, name: "ProjectionThreadQueuedFollowups" },
        { migrationId: 21, name: "AuthSessionClientMetadata" },
        { migrationId: 22, name: "AuthSessionLastConnectedAt" },
        { migrationId: 23, name: "ProjectionThreadQueuedFollowups" },
      ]);
    }),
  );
});
