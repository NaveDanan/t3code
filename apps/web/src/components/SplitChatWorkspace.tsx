/**
 * Split-pane chat workspace.
 *
 * When split mode is active (2 panes), this component renders two `ChatView`
 * instances side-by-side in a flex row, a shared terminal host below them,
 * and the right panel for the selected pane.  When split mode is inactive it
 * renders the normal single `ChatView` wrapped in a drop-target surface so
 * dragging a thread from the sidebar can initiate split mode.
 *
 * Drop targets allow dragging threads from the sidebar into the workspace
 * to create or replace split panes.
 */

import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import ChatView from "./ChatView";
import ThreadTerminalHost from "./ThreadTerminalHost";
import { useSplitViewStore } from "../chatSplitViewStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { selectThreadsAcrossEnvironments, useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import type { TerminalContextSelection } from "../lib/terminalContext";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const THREAD_DRAG_MIME = "application/x-t3-thread-ref";
const MIN_PANE_WIDTH_PX = 360;

// ---------------------------------------------------------------------------
// Drop overlay
// ---------------------------------------------------------------------------

interface DropOverlayProps {
  position: "left" | "right" | "full";
  visible: boolean;
}

function DropOverlay({ position, visible }: DropOverlayProps) {
  if (!visible) return null;
  const positionClasses =
    position === "left" ? "left-0 w-1/2" : position === "right" ? "right-0 w-1/2" : "inset-0";
  return (
    <div
      className={`pointer-events-none absolute top-0 bottom-0 z-40 border-2 border-dashed border-primary/50 bg-primary/5 ${positionClasses}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Pane close button
// ---------------------------------------------------------------------------

interface PaneCloseButtonProps {
  threadKey: string;
  onClose: (threadKey: string) => void;
}

const PaneCloseButton = memo(function PaneCloseButton({
  threadKey,
  onClose,
}: PaneCloseButtonProps) {
  const handleClick = useCallback(() => {
    onClose(threadKey);
  }, [onClose, threadKey]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="absolute top-2 right-2 z-30 flex size-6 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
      aria-label="Close pane"
    >
      <XIcon className="size-3.5" />
    </button>
  );
});

// ---------------------------------------------------------------------------
// SplitChatWorkspace
// ---------------------------------------------------------------------------

interface SplitChatWorkspaceProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Right panel node to render beside the selected pane (or the single pane). */
  rightPanel: ReactNode;
}

function SplitChatWorkspace({ environmentId, threadId, rightPanel }: SplitChatWorkspaceProps) {
  const navigate = useNavigate();
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = scopedThreadKey(routeThreadRef);

  // Split view store
  const paneThreadKeys = useSplitViewStore((s) => s.paneThreadKeys);
  const selectedPaneThreadKey = useSplitViewStore((s) => s.selectedPaneThreadKey);
  const storeSelectPane = useSplitViewStore((s) => s.selectPane);
  const storeClosePane = useSplitViewStore((s) => s.closePane);
  const storeOpenSplitWith = useSplitViewStore((s) => s.openSplitWith);
  const storeSanitizeMissingThreads = useSplitViewStore((s) => s.sanitizeMissingThreads);

  const isSplitActive = paneThreadKeys.length >= 2;

  // Thread existence checks
  const serverThreadKeys = useStore(
    useShallow((state) =>
      selectThreadsAcrossEnvironments(state).map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    ),
  );
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const existingThreadKeys = useMemo(
    () => [...serverThreadKeys, ...draftThreadKeys],
    [serverThreadKeys, draftThreadKeys],
  );

  // Terminal state for the host
  const openTerminalThreadKeys = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalStateByThreadKey ?? {}).flatMap(([key, ts]) =>
        ts.terminalOpen ? [key] : [],
      ),
    ),
  );

  // -----------------------------------------------------------------------
  // Keep split store in sync with route
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!isSplitActive) return;
    // If the route thread is one of the panes, select it
    if (paneThreadKeys.includes(routeThreadKey) && selectedPaneThreadKey !== routeThreadKey) {
      storeSelectPane(routeThreadKey);
    }
  }, [isSplitActive, paneThreadKeys, routeThreadKey, selectedPaneThreadKey, storeSelectPane]);

  // Sanitize missing threads on thread list changes
  useEffect(() => {
    if (!isSplitActive) return;
    const existingSet = new Set(existingThreadKeys);
    storeSanitizeMissingThreads(existingSet);
  }, [isSplitActive, existingThreadKeys, storeSanitizeMissingThreads]);

  // -----------------------------------------------------------------------
  // Pane interaction handlers
  // -----------------------------------------------------------------------

  const handlePaneClick = useCallback(
    (threadKey: string) => {
      if (threadKey === selectedPaneThreadKey) return;
      storeSelectPane(threadKey);
      const ref = parseScopedThreadKey(threadKey);
      if (ref) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(ref),
        });
      }
    },
    [navigate, selectedPaneThreadKey, storeSelectPane],
  );

  const handlePaneClose = useCallback(
    (threadKey: string) => {
      // Figure out which pane will remain after close.
      const remaining = paneThreadKeys.filter((key) => key !== threadKey);
      storeClosePane(threadKey);
      // Navigate to the remaining thread (or stay on current if closing the non-selected pane).
      if (threadKey === selectedPaneThreadKey && remaining.length > 0) {
        const nextRef = parseScopedThreadKey(remaining[0]!);
        if (nextRef) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(nextRef),
          });
        }
      }
    },
    [navigate, paneThreadKeys, selectedPaneThreadKey, storeClosePane],
  );

  // -----------------------------------------------------------------------
  // Drag/drop state
  // -----------------------------------------------------------------------

  const [dropPosition, setDropPosition] = useState<"left" | "right" | "full" | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(THREAD_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";

      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (isSplitActive) {
        const relativeX = event.clientX - rect.left;
        setDropPosition(relativeX < rect.width / 2 ? "left" : "right");
      } else {
        setDropPosition("full");
      }
    },
    [isSplitActive],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    // Only clear if we actually left the workspace element.
    if (
      workspaceRef.current &&
      !workspaceRef.current.contains(event.relatedTarget as Node | null)
    ) {
      setDropPosition(null);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDropPosition(null);

      const data = event.dataTransfer.getData(THREAD_DRAG_MIME);
      if (!data) return;

      const droppedRef = parseScopedThreadKey(data);
      if (!droppedRef) return;

      const droppedThreadKey = scopedThreadKey(droppedRef);

      // Check container width before adding a pane.
      const containerWidth = workspaceRef.current?.clientWidth ?? 0;
      if (!isSplitActive && containerWidth < MIN_PANE_WIDTH_PX * 2) {
        // Not enough room — could show a toast here in the future.
        return;
      }

      // Drop the currently-selected thread = no-op.
      if (droppedThreadKey === routeThreadKey && !isSplitActive) {
        return;
      }

      // openSplitWith handles both creating and adding to split
      storeOpenSplitWith(routeThreadKey, droppedThreadKey);

      // Navigate to the dropped thread since openSplitWith selects it.
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(droppedRef),
      });
    },
    [isSplitActive, navigate, routeThreadKey, storeOpenSplitWith],
  );

  // -----------------------------------------------------------------------
  // Terminal context callback (noop for now — individual composers handle this)
  // -----------------------------------------------------------------------

  const handleAddTerminalContext = useCallback((_selection: TerminalContextSelection) => {
    // In split mode, terminal context is handled per-pane by each ChatView's composer.
  }, []);

  // -----------------------------------------------------------------------
  // Render: single-pane mode with drop target
  // -----------------------------------------------------------------------

  if (!isSplitActive) {
    return (
      <div
        ref={workspaceRef}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ChatView
          environmentId={environmentId}
          threadId={threadId}
          routeKind="server"
          rightPanel={rightPanel}
        />
        {dropPosition && <DropOverlay position={dropPosition} visible />}
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: split-pane mode
  // -----------------------------------------------------------------------

  return (
    <div
      ref={workspaceRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Pane strip + right panel in horizontal layout */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Pane strip */}
        {paneThreadKeys.map((threadKey) => {
          const ref = parseScopedThreadKey(threadKey);
          if (!ref) return null;
          const isSelected = threadKey === selectedPaneThreadKey;

          return (
            <div
              key={threadKey}
              className={`relative flex min-h-0 min-w-0 flex-1 flex-col border-r border-border last:border-r-0 ${
                isSelected ? "ring-2 ring-inset ring-primary/30" : ""
              }`}
              style={{ minWidth: MIN_PANE_WIDTH_PX }}
              onClick={() => handlePaneClick(threadKey)}
              onKeyDown={undefined}
              role="button"
              tabIndex={-1}
            >
              <PaneCloseButton threadKey={threadKey} onClose={handlePaneClose} />
              <ChatView
                environmentId={ref.environmentId}
                threadId={ref.threadId}
                routeKind="server"
                presentation="splitPane"
                isSelectedPane={isSelected}
              />
            </div>
          );
        })}

        {/* Right panel for selected pane — same row as panes */}
        {rightPanel}
      </div>

      {/* Shared terminal host — below the pane strip */}
      <ThreadTerminalHost
        selectedPaneThreadKey={selectedPaneThreadKey}
        openTerminalThreadKeys={openTerminalThreadKeys}
        existingThreadKeys={existingThreadKeys}
        splitShortcutLabel={undefined}
        newShortcutLabel={undefined}
        closeShortcutLabel={undefined}
        onAddTerminalContext={handleAddTerminalContext}
      />

      {/* Drop overlay */}
      {dropPosition && <DropOverlay position={dropPosition} visible />}
    </div>
  );
}

export default SplitChatWorkspace;
