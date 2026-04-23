import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { MessageId, ScopedThreadRef, ThreadId, TurnId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import { decodeThreadDragPayload, hasThreadDragPayload } from "../chatSplitDrag";
import {
  MAX_CHAT_SPLIT_PANES,
  selectPaneThreadRef,
  useChatSplitStore,
  type ChatSplitPane,
} from "../chatSplitStore";
import {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  derivePhase,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  shouldShowCompletionSummary,
} from "../session-logic";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { cn } from "~/lib/utils";
import ChatView from "./ChatView";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { toastManager } from "./ui/toast";

interface ChatSplitViewProps {
  environmentId: ScopedThreadRef["environmentId"];
  threadId: ThreadId;
  routeKind: "server";
  rightPanel?: ReactNode;
}

const EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID: Record<string, boolean> = {};
const EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID = new Map<MessageId, number>();

function refsEqual(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function getNextSelectedPaneAfterClose(
  panes: readonly ChatSplitPane[],
  closingPaneId: string,
): ChatSplitPane | null {
  if (panes.length <= 1) {
    return null;
  }
  const closingIndex = panes.findIndex((pane) => pane.id === closingPaneId);
  if (closingIndex < 0) {
    return null;
  }
  const remaining = panes.filter((pane) => pane.id !== closingPaneId);
  return remaining[Math.min(closingIndex, remaining.length - 1)] ?? remaining[0] ?? null;
}

const ChatThreadPreviewPane = memo(function ChatThreadPreviewPane({
  threadRef,
  selected,
  onSelect,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const thread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const projectRef = thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const { resolvedTheme } = useTheme();
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const phase = derivePhase(thread?.session ?? null);
  const latestTurn = thread?.latestTurn ?? null;
  const latestTurnSettled = isLatestTurnSettled(latestTurn, thread?.session ?? null);
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(thread?.activities ?? [], latestTurn?.turnId ?? undefined),
    [latestTurn?.turnId, thread?.activities],
  );
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(thread?.messages ?? [], thread?.proposedPlans ?? [], workLogEntries),
    [thread?.messages, thread?.proposedPlans, workLogEntries],
  );
  const { turnDiffSummaries } = useTurnDiffSummaries(thread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, (typeof turnDiffSummaries)[number]>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const completionSummary = useMemo(() => {
    const completionDividerEntryId = deriveCompletionDividerBeforeEntryId(
      timelineEntries,
      latestTurn,
    );
    if (!latestTurn?.startedAt || !latestTurn.completedAt) {
      return null;
    }
    const latestTurnHasToolActivity = hasToolActivityForTurn(
      thread?.activities ?? [],
      latestTurn.turnId,
    );
    const provider = thread?.session?.provider ?? thread?.modelSelection.provider;
    if (
      !shouldShowCompletionSummary({
        latestTurnSettled,
        latestTurn,
        hasToolActivity: latestTurnHasToolActivity,
        hasAssistantResponse: completionDividerEntryId !== null,
        provider,
      })
    ) {
      return null;
    }
    const elapsed = formatElapsed(latestTurn.startedAt, latestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    latestTurn,
    latestTurnSettled,
    thread?.activities,
    thread?.modelSelection.provider,
    thread?.session?.provider,
    timelineEntries,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled || !completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, latestTurn);
  }, [completionSummary, latestTurn, latestTurnSettled, timelineEntries]);
  const activeWorkStartedAt = deriveActiveWorkStartedAt(latestTurn, thread?.session ?? null, null);
  const isWorking = phase === "running";
  const gitCwd = project
    ? projectScriptCwd({
        project: { cwd: project.cwd },
        worktreePath: thread?.worktreePath ?? null,
      })
    : null;
  const nowIso = new Date().toISOString();
  const toggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((current) => ({ ...current, [groupId]: !current[groupId] }));
  }, []);
  const openTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      onSelect();
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) => ({
          ...previous,
          rightPanel: "1" as const,
          rightPanelTab: "diff" as const,
          diffTurnId: turnId,
          ...(filePath ? { diffFilePath: filePath } : {}),
        }),
      });
    },
    [navigate, onSelect, threadRef],
  );

  if (!thread) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PaneHeader
          title="Thread unavailable"
          selected={selected}
          onSelect={onSelect}
          onClose={onClose}
        />
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-muted-foreground text-sm">
          This conversation is no longer available.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" onClick={onSelect}>
      <PaneHeader
        title={thread.title}
        {...(project?.name ? { subtitle: project.name } : {})}
        selected={selected}
        onSelect={onSelect}
        onClose={onClose}
      />
      <div
        ref={setScrollContainer}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-4"
      >
        <MessagesTimeline
          key={thread.id}
          hasMessages={timelineEntries.length > 0}
          isWorking={isWorking}
          activeTurnInProgress={isWorking || !latestTurnSettled}
          activeTurnStartedAt={activeWorkStartedAt}
          scrollContainer={scrollContainer}
          timelineEntries={timelineEntries}
          completionDividerBeforeEntryId={completionDividerBeforeEntryId}
          completionSummary={completionSummary}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          nowIso={nowIso}
          activeThreadEnvironmentId={thread.environmentId}
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={toggleWorkGroup}
          changedFilesExpandedByTurnId={EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID}
          onSetChangedFilesExpanded={() => undefined}
          onOpenTurnDiff={openTurnDiff}
          revertTurnCountByUserMessageId={EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID}
          onRevertUserMessage={() => undefined}
          isRevertingCheckpoint={false}
          onImageExpand={setExpandedImage}
          markdownCwd={gitCwd ?? undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={project?.cwd}
        />
      </div>
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </div>
  );
});

function PaneHeader({
  title,
  subtitle,
  selected,
  onSelect,
  onClose,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b border-border px-3",
        selected ? "bg-accent/40" : "bg-card/40",
      )}
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        {subtitle ? (
          <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Close split pane"
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <XIcon className="size-3.5" />
      </button>
    </header>
  );
}

function SplitPaneDropZone({
  pane,
  selected,
  dragOver,
  onPaneDrop,
  onPaneDragOver,
  onPaneDragLeave,
  children,
}: {
  pane: ChatSplitPane;
  selected: boolean;
  dragOver: boolean;
  onPaneDrop: (paneId: string, event: DragEvent<HTMLElement>) => void;
  onPaneDragOver: (paneId: string, event: DragEvent<HTMLElement>) => void;
  onPaneDragLeave: (paneId: string, event: DragEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "relative min-w-[22rem] flex-1 basis-0 overflow-hidden border-border bg-background",
        selected ? "ring-1 ring-inset ring-ring/35" : "border-l",
        dragOver ? "ring-2 ring-inset ring-ring" : null,
      )}
      onDragOver={(event) => onPaneDragOver(pane.id, event)}
      onDragLeave={(event) => onPaneDragLeave(pane.id, event)}
      onDrop={(event) => onPaneDrop(pane.id, event)}
    >
      {children}
    </section>
  );
}

export default function ChatSplitView({
  environmentId,
  threadId,
  routeKind,
  rightPanel,
}: ChatSplitViewProps) {
  const navigate = useNavigate();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const panes = useChatSplitStore((state) => state.panes);
  const selectedPaneId = useChatSplitStore((state) => state.selectedPaneId);
  const reconcileRouteThread = useChatSplitStore((state) => state.reconcileRouteThread);
  const addPane = useChatSplitStore((state) => state.addPane);
  const closePane = useChatSplitStore((state) => state.closePane);
  const selectPaneByThreadRef = useChatSplitStore((state) => state.selectPaneByThreadRef);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);
  const lastRouteThreadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const routeThreadKey = scopedThreadKey(routeThreadRef);
    if (lastRouteThreadKeyRef.current === routeThreadKey) {
      return;
    }
    lastRouteThreadKeyRef.current = routeThreadKey;
    reconcileRouteThread(routeThreadRef);
  }, [reconcileRouteThread, routeThreadRef]);

  const visiblePanes =
    panes.length > 0 ? panes : [{ id: "route", threadKey: scopedThreadKey(routeThreadRef) }];
  const selectedPane =
    visiblePanes.find((pane) => pane.id === selectedPaneId) ?? visiblePanes[0] ?? null;
  const selectedThreadRef = selectedPane ? selectPaneThreadRef(selectedPane) : routeThreadRef;

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      selectPaneByThreadRef(threadRef);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate, selectPaneByThreadRef],
  );

  const handlePaneDragOver = useCallback((paneId: string, event: DragEvent<HTMLElement>) => {
    if (!hasThreadDragPayload(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOverPaneId(paneId);
  }, []);

  const handlePaneDragLeave = useCallback((paneId: string, event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDragOverPaneId((current) => (current === paneId ? null : current));
  }, []);

  const handlePaneDrop = useCallback(
    (paneId: string, event: DragEvent<HTMLElement>) => {
      const droppedThreadRef = decodeThreadDragPayload(event.dataTransfer);
      if (!droppedThreadRef) {
        return;
      }
      event.preventDefault();
      setDragOverPaneId(null);

      const result = addPane(droppedThreadRef, {
        afterPaneId: paneId,
        select: false,
      });
      if (result === "limit-reached") {
        toastManager.add({
          type: "error",
          title: "Split pane limit reached",
          description: `Close a pane before opening more than ${MAX_CHAT_SPLIT_PANES} conversations.`,
        });
      }
    },
    [addPane],
  );

  const handleClosePane = useCallback(
    (pane: ChatSplitPane) => {
      const closingSelectedPane = pane.id === selectedPaneId;
      const nextSelectedPane = closingSelectedPane
        ? getNextSelectedPaneAfterClose(panes, pane.id)
        : null;
      closePane(pane.id);
      if (!nextSelectedPane) {
        return;
      }
      const nextThreadRef = selectPaneThreadRef(nextSelectedPane);
      if (nextThreadRef) {
        navigateToThread(nextThreadRef);
      }
    },
    [closePane, navigateToThread, panes, selectedPaneId],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      {visiblePanes.map((pane) => {
        const paneThreadRef = selectPaneThreadRef(pane);
        if (!paneThreadRef) {
          return null;
        }
        const paneSelected =
          selectedThreadRef !== null && refsEqual(paneThreadRef, selectedThreadRef);
        return (
          <SplitPaneDropZone
            key={pane.id}
            pane={pane}
            selected={paneSelected}
            dragOver={dragOverPaneId === pane.id}
            onPaneDrop={handlePaneDrop}
            onPaneDragOver={handlePaneDragOver}
            onPaneDragLeave={handlePaneDragLeave}
          >
            {paneSelected ? (
              <ChatView
                environmentId={paneThreadRef.environmentId}
                threadId={paneThreadRef.threadId}
                routeKind={routeKind}
                rightPanel={rightPanel}
              />
            ) : (
              <ChatThreadPreviewPane
                threadRef={paneThreadRef}
                selected={false}
                onSelect={() => navigateToThread(paneThreadRef)}
                onClose={() => handleClosePane(pane)}
              />
            )}
          </SplitPaneDropZone>
        );
      })}
    </div>
  );
}
