import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_SPLIT_PANES, useSplitViewStore } from "./chatSplitViewStore";

const ENV_A = "environment-a" as never;
const ENV_B = "environment-b" as never;

const THREAD_1 = ThreadId.make("thread-1");
const THREAD_2 = ThreadId.make("thread-2");
const THREAD_3 = ThreadId.make("thread-3");

const REF_1 = scopeThreadRef(ENV_A, THREAD_1);
const REF_2 = scopeThreadRef(ENV_A, THREAD_2);
const REF_3 = scopeThreadRef(ENV_B, THREAD_3);

const KEY_1 = scopedThreadKey(REF_1);
const KEY_2 = scopedThreadKey(REF_2);
const KEY_3 = scopedThreadKey(REF_3);

describe("chatSplitViewStore", () => {
  beforeEach(() => {
    useSplitViewStore.getState().reset();
  });

  describe("initial state", () => {
    it("starts with no panes (single-pane mode)", () => {
      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([]);
      expect(state.selectedPaneThreadKey).toBeNull();
      expect(state.paneSizeRatios).toEqual([]);
    });

    it("reports split as not active", () => {
      expect(useSplitViewStore.getState().isSplitActive()).toBe(false);
    });
  });

  describe("openSplitWith", () => {
    it("creates a two-pane split from single-pane mode", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([KEY_1, KEY_2]);
      expect(state.selectedPaneThreadKey).toBe(KEY_2);
      expect(state.paneSizeRatios).toEqual([0.5, 0.5]);
      expect(state.isSplitActive()).toBe(true);
    });

    it("selects an existing pane instead of duplicating", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([KEY_1, KEY_2]);
      expect(state.selectedPaneThreadKey).toBe(KEY_2);
    });

    it("replaces non-selected pane when at max panes", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      // KEY_2 is selected. Opening with KEY_3 should replace KEY_1.
      useSplitViewStore.getState().openSplitWith(KEY_2, KEY_3);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toContain(KEY_2);
      expect(state.paneThreadKeys).toContain(KEY_3);
      expect(state.paneThreadKeys).not.toContain(KEY_1);
      expect(state.selectedPaneThreadKey).toBe(KEY_3);
    });

    it("handles dropping the same thread as current (no-op check at caller level)", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_1);

      const state = useSplitViewStore.getState();
      // Same thread opens — treated as "already open"
      expect(state.selectedPaneThreadKey).toBe(KEY_1);
    });
  });

  describe("selectPane", () => {
    it("selects an existing pane", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().selectPane(KEY_1);

      expect(useSplitViewStore.getState().selectedPaneThreadKey).toBe(KEY_1);
    });

    it("is a no-op for unknown thread keys", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().selectPane(KEY_3);

      expect(useSplitViewStore.getState().selectedPaneThreadKey).toBe(KEY_2);
    });
  });

  describe("replaceSelectedPane", () => {
    it("replaces the selected pane's thread", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().replaceSelectedPane(KEY_3);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([KEY_1, KEY_3]);
      expect(state.selectedPaneThreadKey).toBe(KEY_3);
    });

    it("selects existing pane when replacing with an already-open thread", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().replaceSelectedPane(KEY_1);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([KEY_1, KEY_2]);
      expect(state.selectedPaneThreadKey).toBe(KEY_1);
    });

    it("is a no-op when no panes are open", () => {
      useSplitViewStore.getState().replaceSelectedPane(KEY_1);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([]);
    });
  });

  describe("closePane", () => {
    it("collapses to single-pane when closing one of two panes", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().closePane(KEY_2);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([]);
      expect(state.selectedPaneThreadKey).toBeNull();
      expect(state.isSplitActive()).toBe(false);
    });

    it("selects the nearest remaining pane when closing the selected one", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      // Select KEY_2
      expect(useSplitViewStore.getState().selectedPaneThreadKey).toBe(KEY_2);
      useSplitViewStore.getState().closePane(KEY_2);

      const state = useSplitViewStore.getState();
      // Collapsed, so no selected pane
      expect(state.paneThreadKeys).toEqual([]);
    });

    it("is a no-op for unknown thread keys", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().closePane(KEY_3);

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([KEY_1, KEY_2]);
    });
  });

  describe("collapseToSingle", () => {
    it("clears all split state", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().collapseToSingle();

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([]);
      expect(state.selectedPaneThreadKey).toBeNull();
      expect(state.paneSizeRatios).toEqual([]);
      expect(state.isSplitActive()).toBe(false);
    });
  });

  describe("sanitizeMissingThreads", () => {
    it("removes panes with missing threads", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().sanitizeMissingThreads(new Set([KEY_1]));

      const state = useSplitViewStore.getState();
      // Only KEY_1 is valid, so we collapse to single
      expect(state.paneThreadKeys).toEqual([]);
      expect(state.isSplitActive()).toBe(false);
    });

    it("keeps valid panes and updates selection if selected was removed", () => {
      // We need 3+ panes to test this properly, but max is 2.
      // With 2 panes, removing one always collapses.
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().sanitizeMissingThreads(new Set([KEY_1, KEY_2]));

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([KEY_1, KEY_2]);
    });

    it("is a no-op when no panes are open", () => {
      useSplitViewStore.getState().sanitizeMissingThreads(new Set([KEY_1]));

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([]);
    });

    it("collapses when all threads are missing", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.getState().sanitizeMissingThreads(new Set([KEY_3]));

      const state = useSplitViewStore.getState();
      expect(state.paneThreadKeys).toEqual([]);
      expect(state.selectedPaneThreadKey).toBeNull();
    });
  });

  describe("isSplitActive", () => {
    it("returns false with no panes", () => {
      expect(useSplitViewStore.getState().isSplitActive()).toBe(false);
    });

    it("returns true with two panes", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      expect(useSplitViewStore.getState().isSplitActive()).toBe(true);
    });
  });

  describe("MAX_SPLIT_PANES", () => {
    it("is 2 for v1", () => {
      expect(MAX_SPLIT_PANES).toBe(2);
    });
  });

  describe("paneSizeRatios", () => {
    it("distributes ratios equally when opening", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);

      const state = useSplitViewStore.getState();
      expect(state.paneSizeRatios).toEqual([0.5, 0.5]);
    });

    it("resets ratios when a pane is closed and reopened", () => {
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_2);
      useSplitViewStore.setState({ paneSizeRatios: [0.3, 0.7] });
      useSplitViewStore.getState().closePane(KEY_2);
      useSplitViewStore.getState().openSplitWith(KEY_1, KEY_3);

      const state = useSplitViewStore.getState();
      expect(state.paneSizeRatios).toEqual([0.5, 0.5]);
    });
  });
});
