/**
 * Shared terminal host rendered once by the split workspace.
 *
 * In split mode the individual `ChatView` panes do not render their own
 * terminal drawers. Instead, this component renders a single
 * `PersistentThreadTerminalDrawer` set that belongs to the selected pane's
 * thread, keeping terminal state per-thread via `terminalStateStore` and
 * only showing the selected pane's drawer.
 */

import { parseScopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  reconcileMountedTerminalThreadIds,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
} from "./ChatView.logic";
import { PersistentThreadTerminalDrawer } from "./ChatView";
import type { TerminalContextSelection } from "../lib/terminalContext";

interface ThreadTerminalHostProps {
  /** Scoped thread key for the selected (active) pane. */
  selectedPaneThreadKey: string | null;
  /** All thread keys that have open terminals across all panes. */
  openTerminalThreadKeys: readonly string[];
  /** All existing thread keys (server + draft) for pruning. */
  existingThreadKeys: readonly string[];
  /** Shortcut labels passed through to the drawer. */
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  /** Callback when a terminal context is added. */
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

const ThreadTerminalHost = memo(function ThreadTerminalHost(props: ThreadTerminalHostProps) {
  const {
    selectedPaneThreadKey,
    openTerminalThreadKeys,
    existingThreadKeys,
    splitShortcutLabel,
    newShortcutLabel,
    closeShortcutLabel,
    onAddTerminalContext,
  } = props;

  const selectedThreadRef = useMemo<ScopedThreadRef | null>(
    () => (selectedPaneThreadKey ? parseScopedThreadKey(selectedPaneThreadKey) : null),
    [selectedPaneThreadKey],
  );

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, selectedThreadRef),
  );

  const terminalLaunchContext = useTerminalStateStore((state) =>
    selectedPaneThreadKey
      ? (state.terminalLaunchContextByThreadKey[selectedPaneThreadKey] ?? null)
      : null,
  );

  // Existing open terminal thread keys filtered to only existing threads.
  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingSet = new Set(existingThreadKeys);
    return openTerminalThreadKeys.filter((key) => existingSet.has(key));
  }, [existingThreadKeys, openTerminalThreadKeys]);

  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);

  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: selectedPaneThreadKey,
        activeThreadTerminalOpen: Boolean(selectedPaneThreadKey && terminalState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((id, i) => id === nextThreadIds[i])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [selectedPaneThreadKey, existingOpenTerminalThreadKeys, terminalState.terminalOpen]);

  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((key) => {
        const ref = parseScopedThreadKey(key);
        return ref ? [{ key, threadRef: ref }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const [terminalFocusRequestId] = useState(0);

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext],
  );

  if (mountedTerminalThreadRefs.length === 0) {
    return null;
  }

  return (
    <>
      {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadKey}
          threadRef={mountedThreadRef}
          threadId={mountedThreadRef.threadId}
          visible={mountedThreadKey === selectedPaneThreadKey && terminalState.terminalOpen}
          launchContext={
            mountedThreadKey === selectedPaneThreadKey ? (terminalLaunchContext ?? null) : null
          }
          focusRequestId={mountedThreadKey === selectedPaneThreadKey ? terminalFocusRequestId : 0}
          splitShortcutLabel={splitShortcutLabel}
          newShortcutLabel={newShortcutLabel}
          closeShortcutLabel={closeShortcutLabel}
          onAddTerminalContext={handleAddTerminalContext}
        />
      ))}
    </>
  );
});

export default ThreadTerminalHost;
