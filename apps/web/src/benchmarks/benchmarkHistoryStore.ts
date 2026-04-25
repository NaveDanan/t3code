import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { BenchmarkLaneRun } from "./benchmarkRun";
import { resolveStorage } from "../lib/storage";

const BENCHMARK_HISTORY_STORAGE_KEY = "t3code:benchmark-history:v1";
const MAX_BENCHMARK_HISTORY_RUNS = 30;

export type BenchmarkHistoryRun = {
  id: string;
  title: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectName: string;
  projectCwd: string;
  environmentLabel: string;
  baseBranch: string;
  prompt: string;
  lanes: BenchmarkLaneRun[];
  createdAt: string;
  updatedAt: string;
};

export type BenchmarkHistoryRunInput = Omit<BenchmarkHistoryRun, "id" | "createdAt" | "updatedAt">;

interface BenchmarkHistoryState {
  runs: BenchmarkHistoryRun[];
}

interface BenchmarkHistoryActions {
  addRun: (run: BenchmarkHistoryRunInput) => BenchmarkHistoryRun;
  updateRun: (runId: string, patch: Partial<Pick<BenchmarkHistoryRun, "lanes" | "title">>) => void;
  removeRun: (runId: string) => void;
  reset: () => void;
}

export type BenchmarkHistoryStore = BenchmarkHistoryState & BenchmarkHistoryActions;

const initialState: BenchmarkHistoryState = {
  runs: [],
};

function createBenchmarkHistoryStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function createBenchmarkRunId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `benchmark-${Date.now().toString(36)}-${random}`;
}

function isBenchmarkHistoryRun(value: unknown): value is BenchmarkHistoryRun {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<BenchmarkHistoryRun>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.environmentId === "string" &&
    typeof candidate.projectId === "string" &&
    typeof candidate.projectName === "string" &&
    typeof candidate.projectCwd === "string" &&
    typeof candidate.environmentLabel === "string" &&
    typeof candidate.baseBranch === "string" &&
    typeof candidate.prompt === "string" &&
    Array.isArray(candidate.lanes) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function sanitizeRuns(runs: unknown): BenchmarkHistoryRun[] {
  if (!Array.isArray(runs)) {
    return [];
  }

  return runs
    .filter(isBenchmarkHistoryRun)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_BENCHMARK_HISTORY_RUNS);
}

export const useBenchmarkHistoryStore = create<BenchmarkHistoryStore>()(
  persist(
    (set) => ({
      ...initialState,

      addRun: (run) => {
        const now = new Date().toISOString();
        const savedRun: BenchmarkHistoryRun = {
          ...run,
          id: createBenchmarkRunId(),
          createdAt: now,
          updatedAt: now,
        };

        set((state) => ({
          runs: [savedRun, ...state.runs.filter((entry) => entry.id !== savedRun.id)].slice(
            0,
            MAX_BENCHMARK_HISTORY_RUNS,
          ),
        }));

        return savedRun;
      },

      updateRun: (runId, patch) => {
        set((state) => ({
          runs: state.runs.map((run) =>
            run.id === runId ? { ...run, ...patch, updatedAt: new Date().toISOString() } : run,
          ),
        }));
      },

      removeRun: (runId) => {
        set((state) => ({
          runs: state.runs.filter((run) => run.id !== runId),
        }));
      },

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: BENCHMARK_HISTORY_STORAGE_KEY,
      storage: createJSONStorage(createBenchmarkHistoryStorage),
      partialize: (state) => ({
        runs: state.runs,
      }),
      version: 1,
      migrate: (persistedState: unknown, version: number) => {
        if (version === 1 && persistedState && typeof persistedState === "object") {
          return {
            runs: sanitizeRuns((persistedState as Partial<BenchmarkHistoryState>).runs),
          };
        }
        return initialState;
      },
    },
  ),
);
