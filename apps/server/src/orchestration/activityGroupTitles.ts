import { createHash } from "node:crypto";

import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";

import type { ActivityGroupTitleEntry } from "../git/Services/TextGeneration.ts";
import { limitSection } from "../git/Utils.ts";

export const ACTIVITY_GROUP_TITLE_PAYLOAD_KEY = "activityGroupTitle";
export const ACTIVITY_GROUP_TITLE_SIGNATURE_PAYLOAD_KEY = "activityGroupTitleSignature";

export interface ActivityGroupForTitle {
  groupKey: string;
  signature: string;
  groupKind: "tool-calls" | "work-log";
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  entries: ReadonlyArray<ActivityGroupTitleEntry>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function payloadDetail(payload: Record<string, unknown> | null): string | undefined {
  const detail = asTrimmedString(payload?.detail) ?? asTrimmedString(payload?.message);
  return detail ? limitSection(detail, 1_000) : undefined;
}

function payloadData(payload: Record<string, unknown> | null): string | undefined {
  if (payload?.data === undefined) {
    return undefined;
  }
  try {
    return limitSection(JSON.stringify(payload.data), 1_500);
  } catch {
    return undefined;
  }
}

function payloadTitle(payload: Record<string, unknown> | null): string | undefined {
  return asTrimmedString(payload?.title);
}

function payloadItemType(payload: Record<string, unknown> | null): string | undefined {
  return asTrimmedString(payload?.itemType);
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload = asRecord(activity.payload);
  const detail = asTrimmedString(payload?.detail);
  return detail !== undefined && detail.startsWith("ExitPlanMode:");
}

export function isActivityGroupTitleCandidate(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "tool.started") {
    return false;
  }
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return false;
  }
  if (activity.kind === "context-window.updated" || activity.kind === "turn.diff.updated") {
    return false;
  }
  if (activity.summary === "Checkpoint captured") {
    return false;
  }
  if (isPlanBoundaryToolActivity(activity)) {
    return false;
  }
  return (
    activity.tone === "tool" ||
    activity.tone === "info" ||
    activity.tone === "approval" ||
    activity.tone === "error"
  );
}

function compareTimelineItems(left: ActivityTimelineItem, right: ActivityTimelineItem): number {
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  if (left.kind === "work" && right.kind === "work") {
    const leftSequence = left.activity.sequence;
    const rightSequence = right.activity.sequence;
    if (leftSequence !== undefined && rightSequence !== undefined) {
      return leftSequence - rightSequence;
    }
    if (leftSequence !== undefined) {
      return 1;
    }
    if (rightSequence !== undefined) {
      return -1;
    }
  }

  return left.id.localeCompare(right.id);
}

type ActivityTimelineItem =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      activity: OrchestrationThreadActivity;
    }
  | {
      kind: "break";
      id: string;
      createdAt: string;
    };

function toTitleEntry(activity: OrchestrationThreadActivity): ActivityGroupTitleEntry {
  const payload = asRecord(activity.payload);
  const title = payloadTitle(payload);
  const itemType = payloadItemType(payload);
  const detail = payloadDetail(payload);
  const data = payloadData(payload);
  return {
    label: activity.summary,
    kind: activity.kind,
    tone: activity.tone,
    ...(title ? { title } : {}),
    ...(itemType ? { itemType } : {}),
    ...(detail ? { detail } : {}),
    ...(data ? { data } : {}),
  };
}

function buildTimeline(thread: OrchestrationThread): ActivityTimelineItem[] {
  const workItems: ActivityTimelineItem[] = thread.activities
    .filter(isActivityGroupTitleCandidate)
    .map((activity) => ({
      kind: "work" as const,
      id: activity.id,
      createdAt: activity.createdAt,
      activity,
    }));
  const messageItems: ActivityTimelineItem[] = thread.messages.map((message) => ({
    kind: "break" as const,
    id: message.id,
    createdAt: message.createdAt,
  }));
  const proposedPlanItems: ActivityTimelineItem[] = thread.proposedPlans.map((proposedPlan) => ({
    kind: "break" as const,
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
  }));

  return [...workItems, ...messageItems, ...proposedPlanItems].toSorted(compareTimelineItems);
}

function signatureForActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  entries: ReadonlyArray<ActivityGroupTitleEntry>,
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        activityIds: activities.map((activity) => activity.id),
        entries,
      }),
    )
    .digest("base64url")
    .slice(0, 18);
  const firstId = activities[0]?.id ?? "empty";
  const lastId = activities.at(-1)?.id ?? "empty";
  return `${firstId}:${lastId}:${activities.length}:${hash}`;
}

export function deriveActivityGroupForTitle(
  thread: OrchestrationThread,
  activityId: string,
): ActivityGroupForTitle | null {
  const timeline = buildTimeline(thread);
  const targetIndex = timeline.findIndex(
    (item) => item.kind === "work" && item.activity.id === activityId,
  );
  if (targetIndex < 0) {
    return null;
  }

  let startIndex = targetIndex;
  while (startIndex > 0 && timeline[startIndex - 1]?.kind === "work") {
    startIndex -= 1;
  }

  let endIndex = targetIndex;
  while (endIndex + 1 < timeline.length && timeline[endIndex + 1]?.kind === "work") {
    endIndex += 1;
  }

  const activities = timeline
    .slice(startIndex, endIndex + 1)
    .flatMap((item) => (item.kind === "work" ? [item.activity] : []));
  if (activities.length === 0) {
    return null;
  }

  const entries = activities.slice(-8).map(toTitleEntry);
  const groupKey = `${thread.id}:${activities[0]?.id ?? activityId}`;
  const signature = signatureForActivities(activities, entries);
  const groupKind = activities.every((activity) => activity.tone === "tool")
    ? "tool-calls"
    : "work-log";

  return {
    groupKey,
    signature,
    groupKind,
    activities,
    entries,
  };
}

export function payloadWithActivityGroupTitle(
  payload: unknown,
  title: string,
  signature: string,
): Record<string, unknown> {
  const payloadRecord = asRecord(payload);
  const base =
    payloadRecord ??
    (payload === undefined || payload === null
      ? {}
      : {
          value: payload,
        });
  return {
    ...base,
    [ACTIVITY_GROUP_TITLE_PAYLOAD_KEY]: title,
    [ACTIVITY_GROUP_TITLE_SIGNATURE_PAYLOAD_KEY]: signature,
  };
}

export function readActivityGroupTitle(payload: unknown): string | undefined {
  const payloadRecord = asRecord(payload);
  return asTrimmedString(payloadRecord?.[ACTIVITY_GROUP_TITLE_PAYLOAD_KEY]);
}

export function readActivityGroupTitleSignature(payload: unknown): string | undefined {
  const payloadRecord = asRecord(payload);
  return asTrimmedString(payloadRecord?.[ACTIVITY_GROUP_TITLE_SIGNATURE_PAYLOAD_KEY]);
}
