import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_CHAT_SPLIT_PANES, selectPaneThreadRef, useChatSplitStore } from "./chatSplitStore";

function threadRef(threadId: string) {
  return scopeThreadRef("env-1" as EnvironmentId, threadId as ThreadId);
}

function resetStore() {
  useChatSplitStore.setState({ panes: [], selectedPaneId: null });
}

describe("chatSplitStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("reconciles the first route thread into a selected pane", () => {
    const ref = threadRef("thread-1");

    useChatSplitStore.getState().reconcileRouteThread(ref);

    const state = useChatSplitStore.getState();
    expect(state.panes).toHaveLength(1);
    expect(state.selectedPaneId).toBe(state.panes[0]?.id);
    expect(selectPaneThreadRef(state.panes[0]!)).toEqual(ref);
  });

  it("adds a new pane and can keep the current selection", () => {
    const first = threadRef("thread-1");
    const second = threadRef("thread-2");
    useChatSplitStore.getState().openSingleThread(first);
    const selectedBefore = useChatSplitStore.getState().selectedPaneId;

    const result = useChatSplitStore.getState().addPane(second, { select: false });

    const state = useChatSplitStore.getState();
    expect(result).toBe("added");
    expect(state.panes).toHaveLength(2);
    expect(state.selectedPaneId).toBe(selectedBefore);
    expect(state.panes.map(selectPaneThreadRef)).toEqual([first, second]);
  });

  it("selects an already open pane instead of duplicating it", () => {
    const first = threadRef("thread-1");
    const second = threadRef("thread-2");
    useChatSplitStore.getState().openSingleThread(first);
    useChatSplitStore.getState().addPane(second);
    const secondPaneId = useChatSplitStore.getState().selectedPaneId;

    const result = useChatSplitStore.getState().addPane(first);

    const state = useChatSplitStore.getState();
    expect(result).toBe("selected-existing");
    expect(state.panes).toHaveLength(2);
    expect(state.selectedPaneId).not.toBe(secondPaneId);
    expect(
      selectPaneThreadRef(state.panes.find((pane) => pane.id === state.selectedPaneId)!),
    ).toEqual(first);
  });

  it("enforces the split pane limit", () => {
    useChatSplitStore.getState().openSingleThread(threadRef("thread-1"));
    for (let index = 2; index <= MAX_CHAT_SPLIT_PANES; index += 1) {
      expect(useChatSplitStore.getState().addPane(threadRef(`thread-${index}`))).toBe("added");
    }

    expect(useChatSplitStore.getState().addPane(threadRef("thread-overflow"))).toBe(
      "limit-reached",
    );
    expect(useChatSplitStore.getState().panes).toHaveLength(MAX_CHAT_SPLIT_PANES);
  });

  it("moves selection when closing the selected pane", () => {
    const first = threadRef("thread-1");
    const second = threadRef("thread-2");
    useChatSplitStore.getState().openSingleThread(first);
    useChatSplitStore.getState().addPane(second);
    const selectedPaneId = useChatSplitStore.getState().selectedPaneId!;

    useChatSplitStore.getState().closePane(selectedPaneId);

    const state = useChatSplitStore.getState();
    expect(state.panes).toHaveLength(1);
    expect(state.selectedPaneId).toBe(state.panes[0]?.id);
    expect(selectPaneThreadRef(state.panes[0]!)).toEqual(first);
  });
});
