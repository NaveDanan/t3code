import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export const MAX_CHAT_SPLIT_PANES = 4;

export interface ChatSplitPane {
  id: string;
  threadKey: string;
}

interface ChatSplitStore {
  panes: ChatSplitPane[];
  selectedPaneId: string | null;
  openSingleThread: (threadRef: ScopedThreadRef) => void;
  reconcileRouteThread: (threadRef: ScopedThreadRef) => void;
  addPane: (
    threadRef: ScopedThreadRef,
    options?: {
      afterPaneId?: string | null;
      select?: boolean;
    },
  ) => "added" | "selected-existing" | "limit-reached";
  selectPaneByThreadRef: (threadRef: ScopedThreadRef) => void;
  closePane: (paneId: string) => void;
}

let nextPaneSequence = 0;

function createPane(threadRef: ScopedThreadRef): ChatSplitPane {
  nextPaneSequence += 1;
  return {
    id: `chat-pane-${nextPaneSequence}`,
    threadKey: scopedThreadKey(threadRef),
  };
}

function refsEqual(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function paneThreadRef(pane: ChatSplitPane): ScopedThreadRef | null {
  return parseScopedThreadKey(pane.threadKey);
}

export function selectPaneThreadRef(pane: ChatSplitPane): ScopedThreadRef | null {
  return paneThreadRef(pane);
}

function findPaneByThreadRef(
  panes: readonly ChatSplitPane[],
  threadRef: ScopedThreadRef,
): ChatSplitPane | undefined {
  return panes.find((pane) => {
    const ref = paneThreadRef(pane);
    return ref !== null && refsEqual(ref, threadRef);
  });
}

export const useChatSplitStore = create<ChatSplitStore>((set) => ({
  panes: [],
  selectedPaneId: null,

  openSingleThread: (threadRef) => {
    const pane = createPane(threadRef);
    set({ panes: [pane], selectedPaneId: pane.id });
  },

  reconcileRouteThread: (threadRef) => {
    set((state) => {
      if (state.panes.length === 0) {
        const pane = createPane(threadRef);
        return { panes: [pane], selectedPaneId: pane.id };
      }

      const existingPane = findPaneByThreadRef(state.panes, threadRef);
      if (existingPane) {
        return state.selectedPaneId === existingPane.id
          ? state
          : { selectedPaneId: existingPane.id };
      }

      const selectedPaneId = state.selectedPaneId ?? state.panes[0]?.id ?? null;
      if (!selectedPaneId) {
        const pane = createPane(threadRef);
        return { panes: [pane], selectedPaneId: pane.id };
      }

      const nextPanes = state.panes.map((pane) =>
        pane.id === selectedPaneId ? { ...pane, threadKey: scopedThreadKey(threadRef) } : pane,
      );
      return { panes: nextPanes, selectedPaneId };
    });
  },

  addPane: (threadRef, options) => {
    let result: "added" | "selected-existing" | "limit-reached" = "added";
    set((state) => {
      const existingPane = findPaneByThreadRef(state.panes, threadRef);
      if (existingPane) {
        result = "selected-existing";
        return options?.select === false ? state : { selectedPaneId: existingPane.id };
      }

      if (state.panes.length >= MAX_CHAT_SPLIT_PANES) {
        result = "limit-reached";
        return state;
      }

      const pane = createPane(threadRef);
      if (state.panes.length === 0) {
        return { panes: [pane], selectedPaneId: pane.id };
      }

      const afterPaneId = options?.afterPaneId ?? state.selectedPaneId;
      const afterIndex = afterPaneId
        ? state.panes.findIndex((candidate) => candidate.id === afterPaneId)
        : -1;
      const insertIndex = afterIndex >= 0 ? afterIndex + 1 : state.panes.length;
      const nextPanes = [
        ...state.panes.slice(0, insertIndex),
        pane,
        ...state.panes.slice(insertIndex),
      ];
      return {
        panes: nextPanes,
        selectedPaneId: options?.select === false ? state.selectedPaneId : pane.id,
      };
    });
    return result;
  },

  selectPaneByThreadRef: (threadRef) => {
    set((state) => {
      const pane = findPaneByThreadRef(state.panes, threadRef);
      if (!pane || pane.id === state.selectedPaneId) {
        return state;
      }
      return { selectedPaneId: pane.id };
    });
  },

  closePane: (paneId) => {
    set((state) => {
      if (state.panes.length <= 1) {
        return state;
      }

      const closingIndex = state.panes.findIndex((pane) => pane.id === paneId);
      if (closingIndex < 0) {
        return state;
      }

      const nextPanes = state.panes.filter((pane) => pane.id !== paneId);
      if (state.selectedPaneId !== paneId) {
        return { panes: nextPanes };
      }

      const nextSelectedPane =
        nextPanes[Math.min(closingIndex, nextPanes.length - 1)] ?? nextPanes[0] ?? null;
      return {
        panes: nextPanes,
        selectedPaneId: nextSelectedPane?.id ?? null,
      };
    });
  },
}));
