import { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionQueuedFollowupLookup,
  ProjectionQueuedFollowup,
  ProjectionQueuedFollowupRepository,
  type ProjectionQueuedFollowupRepositoryShape,
  ProjectionQueuedFollowupsByThreadInput,
} from "../Services/ProjectionQueuedFollowups.ts";

const ProjectionQueuedFollowupDbRowSchema = ProjectionQueuedFollowup.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  }),
);

function toProjectionQueuedFollowup(
  row: Schema.Schema.Type<typeof ProjectionQueuedFollowupDbRowSchema>,
): ProjectionQueuedFollowup {
  return {
    id: row.id,
    threadId: row.threadId,
    messageId: row.messageId,
    text: row.text,
    attachments: row.attachments,
    ...(row.modelSelection !== null ? { modelSelection: row.modelSelection } : {}),
    interactionMode: row.interactionMode,
    sourceProposedPlanThreadId: row.sourceProposedPlanThreadId,
    sourceProposedPlanId: row.sourceProposedPlanId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeProjectionQueuedFollowupRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertQueuedFollowupRow = SqlSchema.void({
    Request: ProjectionQueuedFollowup,
    execute: (row) =>
      sql`
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
          ${row.id},
          ${row.threadId},
          ${row.messageId},
          ${row.text},
          ${JSON.stringify(row.attachments)},
          ${row.modelSelection !== undefined ? JSON.stringify(row.modelSelection) : null},
          ${row.interactionMode},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (queued_followup_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          message_id = excluded.message_id,
          text = excluded.text,
          attachments_json = excluded.attachments_json,
          model_selection_json = excluded.model_selection_json,
          interaction_mode = excluded.interaction_mode,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getQueuedFollowupRow = SqlSchema.findOneOption({
    Request: ProjectionQueuedFollowupLookup,
    Result: ProjectionQueuedFollowupDbRowSchema,
    execute: ({ threadId, queuedFollowupId }) =>
      sql`
        SELECT
          queued_followup_id AS "id",
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_followups
        WHERE thread_id = ${threadId}
          AND queued_followup_id = ${queuedFollowupId}
        LIMIT 1
      `,
  });

  const listQueuedFollowupRows = SqlSchema.findAll({
    Request: ProjectionQueuedFollowupsByThreadInput,
    Result: ProjectionQueuedFollowupDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          queued_followup_id AS "id",
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachments_json AS "attachments",
          model_selection_json AS "modelSelection",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_queued_followups
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, queued_followup_id ASC
      `,
  });

  const deleteQueuedFollowupRow = SqlSchema.void({
    Request: ProjectionQueuedFollowupLookup,
    execute: ({ threadId, queuedFollowupId }) =>
      sql`
        DELETE FROM projection_thread_queued_followups
        WHERE thread_id = ${threadId}
          AND queued_followup_id = ${queuedFollowupId}
      `,
  });

  const deleteQueuedFollowupRowsByThread = SqlSchema.void({
    Request: ProjectionQueuedFollowupsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_queued_followups
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionQueuedFollowupRepositoryShape["upsert"] = (row) =>
    upsertQueuedFollowupRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueuedFollowupRepository.upsert:query")),
    );

  const getById: ProjectionQueuedFollowupRepositoryShape["getById"] = (input) =>
    getQueuedFollowupRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueuedFollowupRepository.getById:query")),
      Effect.map(Option.map(toProjectionQueuedFollowup)),
    );

  const listByThreadId: ProjectionQueuedFollowupRepositoryShape["listByThreadId"] = (input) =>
    listQueuedFollowupRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionQueuedFollowupRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionQueuedFollowup)),
    );

  const deleteById: ProjectionQueuedFollowupRepositoryShape["deleteById"] = (input) =>
    deleteQueuedFollowupRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueuedFollowupRepository.deleteById:query")),
    );

  const deleteByThreadId: ProjectionQueuedFollowupRepositoryShape["deleteByThreadId"] = (input) =>
    deleteQueuedFollowupRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionQueuedFollowupRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByThreadId,
    deleteById,
    deleteByThreadId,
  } satisfies ProjectionQueuedFollowupRepositoryShape;
});

export const ProjectionQueuedFollowupRepositoryLive = Layer.effect(
  ProjectionQueuedFollowupRepository,
  makeProjectionQueuedFollowupRepository,
);
