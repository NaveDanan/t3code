/**
 * Zustand store for split-pane chat workspace state.
 *
 * Tracks which threads are open in split panes, which pane is selected,
 * and pane size ratios. Persisted to localStorage.
 *
 * v1 scope:
 * - Max 2 panes
 * - Server threads only (no drafts)
 * - Selected pane drives the route
 */

import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

const SPLIT_VIEW_STORAGE_KEY = "t3code:split-view:v1";

/** Maximum number of concurrent panes in v1. */
export const MAX_SPLIT_PANES = 2;

export interface SplitViewState {
  /** Ordered list of scoped thread keys, one per pane. Empty = single-pane mode. */
  paneThreadKeys: string[];
  /** The scoped thread key of the currently selected (focused) pane, or null. */
  selectedPaneThreadKey: string | null;
  /**
   * Ratio of each pane's width as a fraction of total available width.
   * Length matches `paneThreadKeys.length`. Defaults to equal distribution.
   */
  paneSizeRatios: number[];
}

export interface SplitViewActions {
  /**
   * Open a second pane with the given thread, creating a split from single-pane mode.
   * If already in split mode and at max panes, replaces the non-selected pane.
   * No-op if the thread is already open.
   */
  openSplitWith: (currentThreadKey: string, newThreadKey: string) => void;

  /** Select a pane by its scoped thread key. No-op if not found. */
  selectPane: (threadKey: string) => void;

  /** Replace the currently selected pane's thread with a new thread key. */
  replaceSelectedPane: (newThreadKey: string) => void;

  /** Close a specific pane. If only one pane remains, collapses to single-pane mode. */
  closePane: (threadKey: string) => void;

  /** Collapse split mode back to single-pane. Keeps the selected pane's thread. */
  collapseToSingle: () => void;

  /**
   * Remove panes whose thread keys are not in the provided set of valid keys.
   * Used on reload/bootstrap to clean up stale threads.
   */
  sanitizeMissingThreads: (validThreadKeys: ReadonlySet<string>) => void;

  /** Check whether split mode is active (2+ panes). */
  isSplitActive: () => boolean;

  /** Reset all split state (for tests). */
  reset: () => void;
}

export type SplitViewStore = SplitViewState & SplitViewActions;

const initialState: SplitViewState = {
  paneThreadKeys: [],
  selectedPaneThreadKey: null,
  paneSizeRatios: [],
};

function equalRatios(count: number): number[] {
  if (count <= 0) return [];
  const ratio = 1 / count;
  return Array.from({ length: count }, () => ratio);
}

function createSplitViewStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

export const useSplitViewStore = create<SplitViewStore>()(
  persist(
    (set, get) => ({
      ...initialState,

      openSplitWith: (currentThreadKey: string, newThreadKey: string) => {
        const state = get();

        // If the new thread is already open, just select it
        if (state.paneThreadKeys.includes(newThreadKey)) {
          set({ selectedPaneThreadKey: newThreadKey });
          return;
        }

        if (state.paneThreadKeys.length === 0) {
          // Currently single-pane: create a split with current + new
          const paneThreadKeys = [currentThreadKey, newThreadKey];
          set({
            paneThreadKeys,
            selectedPaneThreadKey: newThreadKey,
            paneSizeRatios: equalRatios(paneThreadKeys.length),
          });
          return;
        }

        if (state.paneThreadKeys.length < MAX_SPLIT_PANES) {
          // Room for another pane
          const paneThreadKeys = [...state.paneThreadKeys, newThreadKey];
          set({
            paneThreadKeys,
            selectedPaneThreadKey: newThreadKey,
            paneSizeRatios: equalRatios(paneThreadKeys.length),
          });
          return;
        }

        // At max panes: replace the non-selected pane
        const paneThreadKeys = state.paneThreadKeys.map((key) =>
          key === state.selectedPaneThreadKey ? key : newThreadKey,
        );
        set({
          paneThreadKeys,
          selectedPaneThreadKey: newThreadKey,
          paneSizeRatios: equalRatios(paneThreadKeys.length),
        });
      },

      selectPane: (threadKey: string) => {
        const state = get();
        if (!state.paneThreadKeys.includes(threadKey)) return;
        set({ selectedPaneThreadKey: threadKey });
      },

      replaceSelectedPane: (newThreadKey: string) => {
        const state = get();

        // If already open in another pane, just select that pane
        if (state.paneThreadKeys.includes(newThreadKey)) {
          set({ selectedPaneThreadKey: newThreadKey });
          return;
        }

        if (state.paneThreadKeys.length === 0 || !state.selectedPaneThreadKey) return;

        const paneThreadKeys = state.paneThreadKeys.map((key) =>
          key === state.selectedPaneThreadKey ? newThreadKey : key,
        );
        set({
          paneThreadKeys,
          selectedPaneThreadKey: newThreadKey,
          paneSizeRatios: state.paneSizeRatios,
        });
      },

      closePane: (threadKey: string) => {
        const state = get();
        const index = state.paneThreadKeys.indexOf(threadKey);
        if (index === -1) return;

        const remaining = state.paneThreadKeys.filter((key) => key !== threadKey);

        if (remaining.length <= 1) {
          // Collapse to single-pane
          set({
            paneThreadKeys: [],
            selectedPaneThreadKey: null,
            paneSizeRatios: [],
          });
          return;
        }

        // Select the nearest remaining pane
        const nextSelected =
          state.selectedPaneThreadKey === threadKey
            ? (remaining[Math.min(index, remaining.length - 1)] ?? remaining[0] ?? null)
            : state.selectedPaneThreadKey;

        set({
          paneThreadKeys: remaining,
          selectedPaneThreadKey: nextSelected,
          paneSizeRatios: equalRatios(remaining.length),
        });
      },

      collapseToSingle: () => {
        set({
          paneThreadKeys: [],
          selectedPaneThreadKey: null,
          paneSizeRatios: [],
        });
      },

      sanitizeMissingThreads: (validThreadKeys: ReadonlySet<string>) => {
        const state = get();
        if (state.paneThreadKeys.length === 0) return;

        const remaining = state.paneThreadKeys.filter((key) => validThreadKeys.has(key));

        if (remaining.length === state.paneThreadKeys.length) return;

        if (remaining.length <= 1) {
          set({
            paneThreadKeys: [],
            selectedPaneThreadKey: null,
            paneSizeRatios: [],
          });
          return;
        }

        const nextSelected =
          state.selectedPaneThreadKey && remaining.includes(state.selectedPaneThreadKey)
            ? state.selectedPaneThreadKey
            : (remaining[0] ?? null);

        set({
          paneThreadKeys: remaining,
          selectedPaneThreadKey: nextSelected,
          paneSizeRatios: equalRatios(remaining.length),
        });
      },

      isSplitActive: () => {
        return get().paneThreadKeys.length >= 2;
      },

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: SPLIT_VIEW_STORAGE_KEY,
      storage: createJSONStorage(createSplitViewStorage),
      partialize: (state) => ({
        paneThreadKeys: state.paneThreadKeys,
        selectedPaneThreadKey: state.selectedPaneThreadKey,
        paneSizeRatios: state.paneSizeRatios,
      }),
      version: 1,
      migrate: (persistedState: unknown, version: number) => {
        if (version === 1 && persistedState && typeof persistedState === "object") {
          const candidate = persistedState as Partial<SplitViewState>;
          const paneThreadKeys = Array.isArray(candidate.paneThreadKeys)
            ? candidate.paneThreadKeys.filter(
                (key): key is string =>
                  typeof key === "string" && parseScopedThreadKey(key) !== null,
              )
            : [];
          const selectedPaneThreadKey =
            typeof candidate.selectedPaneThreadKey === "string" &&
            paneThreadKeys.includes(candidate.selectedPaneThreadKey)
              ? candidate.selectedPaneThreadKey
              : (paneThreadKeys[0] ?? null);
          return {
            paneThreadKeys,
            selectedPaneThreadKey,
            paneSizeRatios: equalRatios(paneThreadKeys.length),
          };
        }
        return initialState;
      },
    },
  ),
);

/** Build a ScopedThreadRef from a scoped thread key stored in the split view store. */
export function splitPaneThreadRef(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

/** Helper to get the scoped thread key for a ScopedThreadRef. */
export { scopedThreadKey };
