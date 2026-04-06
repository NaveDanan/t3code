import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  type OrchestrationQueuedFollowup,
  QueuedFollowupId,
  ThreadId,
  ModelSelection,
  ProviderInteractionMode,
  OrchestrationProposedPlanId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionQueuedFollowup = Schema.Struct({
  id: QueuedFollowupId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: ProviderInteractionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionQueuedFollowup = typeof ProjectionQueuedFollowup.Type;

export const ProjectionQueuedFollowupLookup = Schema.Struct({
  threadId: ThreadId,
  queuedFollowupId: QueuedFollowupId,
});
export type ProjectionQueuedFollowupLookup = typeof ProjectionQueuedFollowupLookup.Type;

export const ProjectionQueuedFollowupsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectionQueuedFollowupsByThreadInput =
  typeof ProjectionQueuedFollowupsByThreadInput.Type;

export interface ProjectionQueuedFollowupRepositoryShape {
  readonly upsert: (
    row: ProjectionQueuedFollowup,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: ProjectionQueuedFollowupLookup,
  ) => Effect.Effect<Option.Option<ProjectionQueuedFollowup>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ProjectionQueuedFollowupsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionQueuedFollowup>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: ProjectionQueuedFollowupLookup,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ProjectionQueuedFollowupsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionQueuedFollowupRepository extends ServiceMap.Service<
  ProjectionQueuedFollowupRepository,
  ProjectionQueuedFollowupRepositoryShape
>()("t3/persistence/Services/ProjectionQueuedFollowups/ProjectionQueuedFollowupRepository") {}

export function projectionQueuedFollowupToReadModel(
  row: ProjectionQueuedFollowup,
): OrchestrationQueuedFollowup {
  return {
    id: row.id,
    messageId: row.messageId,
    text: row.text,
    attachments: row.attachments,
    ...(row.modelSelection !== undefined ? { modelSelection: row.modelSelection } : {}),
    interactionMode: row.interactionMode,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
