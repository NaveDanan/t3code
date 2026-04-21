import { type MessageId } from "@t3tools/contracts";
import { parseUnifiedDiffFiles } from "@t3tools/shared/diff";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { estimateTimelineMessageHeight } from "../timelineHeight";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const MAX_GROUP_CARD_TITLE_WORDS = 7;

export function deriveGroupCardSummary(entries: ReadonlyArray<WorkLogEntry>): string {
  const generatedGroupTitle = entries.find((entry) => entry.groupTitle)?.groupTitle;
  if (generatedGroupTitle) {
    return truncateToWords(generatedGroupTitle, MAX_GROUP_CARD_TITLE_WORDS);
  }

  // Thinking entries capture the model's intent most directly
  const thinkingEntry = entries.find((e) => e.tone === "thinking");
  if (thinkingEntry) {
    return truncateToWords(thinkingEntry.label, MAX_GROUP_CARD_TITLE_WORDS);
  }

  // Use the most frequently occurring toolTitle across entries
  const toolTitleCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.toolTitle) {
      toolTitleCounts.set(entry.toolTitle, (toolTitleCounts.get(entry.toolTitle) ?? 0) + 1);
    }
  }
  if (toolTitleCounts.size > 0) {
    const dominantTitle = [...toolTitleCounts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0];
    if (dominantTitle) return truncateToWords(dominantTitle, MAX_GROUP_CARD_TITLE_WORDS);
  }

  // Fall back to the first entry's label
  const firstLabel = entries[0]?.label;
  if (firstLabel) {
    return truncateToWords(firstLabel, MAX_GROUP_CARD_TITLE_WORDS);
  }

  return entries.every((e) => e.tone === "tool") ? "Tool calls" : "Work log";
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ");
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
    });
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function estimateMessagesTimelineRowHeight(
  row: MessagesTimelineRow,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
    turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
  },
): number {
  switch (row.kind) {
    case "work":
      return estimateWorkRowHeight(row, input);
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan);
    case "working":
      return 40;
    case "message": {
      let estimate = estimateTimelineMessageHeight(row.message, {
        timelineWidthPx: input.timelineWidthPx,
      });
      const turnDiffSummary = input.turnDiffSummaryByAssistantMessageId?.get(row.message.id);
      if (turnDiffSummary && turnDiffSummary.files.length > 0) {
        estimate += estimateChangedFilesCardHeight(turnDiffSummary);
      }
      return estimate;
    }
  }
}

function estimateWorkRowHeight(
  row: Extract<MessagesTimelineRow, { kind: "work" }>,
  input: {
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
  },
): number {
  const isExpanded = input.expandedWorkGroups?.[row.id] ?? false;
  const hasOverflow = row.groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded ? MAX_VISIBLE_WORK_LOG_ENTRIES : row.groupedEntries.length;
  const reviewCardsHeight = row.groupedEntries
    .slice(hasOverflow && !isExpanded ? -MAX_VISIBLE_WORK_LOG_ENTRIES : 0)
    .slice(0, visibleEntries)
    .reduce((total, entry) => total + estimateWorkEntryReviewHeight(entry), 0);

  // Card chrome, header (always shown with summary title), and one compact work-entry row per visible entry.
  return 28 + 26 + visibleEntries * 32 + reviewCardsHeight;
}

function estimateTimelineProposedPlanHeight(proposedPlan: ProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

function estimateChangedFilesCardHeight(turnDiffSummary: TurnDiffSummary): number {
  const treeNodes = buildTurnDiffTree(turnDiffSummary.files);
  const visibleNodeCount = countTurnDiffTreeNodes(treeNodes);

  // Card chrome: top/bottom padding, header row, and tree spacing.
  return 60 + visibleNodeCount * 25;
}

function estimateWorkEntryReviewHeight(entry: WorkLogEntry): number {
  const diffFileCount = countDiffFiles(entry.unifiedDiff);
  if (diffFileCount === 1) {
    return 260;
  }
  if (diffFileCount > 1) {
    return 56 + Math.min(diffFileCount, 6) * 42;
  }
  const changedFileCount = entry.changedFiles?.length ?? 0;
  if (changedFileCount > 0) {
    return 56 + Math.min(changedFileCount, 6) * 34;
  }
  if (typeof entry.unifiedDiff === "string" && entry.unifiedDiff.trim().length > 0) {
    const headerCount = entry.unifiedDiff.match(/^diff --git /gm)?.length ?? 0;
    if (headerCount > 0) {
      return 56 + Math.min(headerCount, 6) * 42;
    }
    return 92;
  }
  return 0;
}

function countDiffFiles(unifiedDiff: string | undefined): number {
  if (typeof unifiedDiff !== "string" || unifiedDiff.trim().length === 0) {
    return 0;
  }
  try {
    return parseUnifiedDiffFiles(unifiedDiff).length;
  } catch {
    return 0;
  }
}

function countTurnDiffTreeNodes(nodes: ReadonlyArray<TurnDiffTreeNode>): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "directory") {
      count += countTurnDiffTreeNodes(node.children);
    }
  }
  return count;
}
