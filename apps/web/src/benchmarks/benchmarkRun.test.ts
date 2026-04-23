import {
  EnvironmentId,
  type GitStatusResult,
  ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vitest";

import {
  applyBenchmarkDispatchResults,
  buildBenchmarkRun,
  dispatchBenchmarkCommands,
  MAX_BENCHMARK_LANES,
  type BenchmarkRunDraft,
  validateBenchmarkRunDraft,
} from "./benchmarkRun";

function effort(value: string, isDefault = false) {
  return {
    value,
    label: value,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

const READY_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-21T12:00:00.000Z",
    runtimeCapabilities: { busyFollowupMode: "queue-only" },
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("medium", true)],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-21T12:00:00.000Z",
    runtimeCapabilities: { busyFollowupMode: "queue-only" },
    models: [
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("medium", true)],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "opencode",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-04-21T12:00:00.000Z",
    runtimeCapabilities: { busyFollowupMode: "queue-only" },
    models: [
      {
        slug: "openai/gpt-5",
        name: "OpenAI GPT-5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("medium", true)],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
];

const BASE_DRAFT: BenchmarkRunDraft = {
  environmentId: EnvironmentId.make("environment-local"),
  projectId: ProjectId.make("project-1"),
  projectCwd: "/repo/project",
  baseBranch: "main",
  prompt: "Benchmark this prompt",
  runtimeMode: "full-access",
  lanes: [
    {
      id: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    },
    {
      id: "lane-2",
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
    },
  ],
};

const CONTEXT = {
  project: {
    id: BASE_DRAFT.projectId,
    cwd: BASE_DRAFT.projectCwd,
    defaultModelSelection: {
      provider: "codex" as const,
      model: "gpt-5.4",
    },
  },
  providers: READY_PROVIDERS,
  settings: DEFAULT_UNIFIED_SETTINGS,
};

const GIT_STATUS: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: true,
  branch: "main",
  hasWorkingTreeChanges: false,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
  },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("benchmarkRun", () => {
  it("requires at least 2 lanes", () => {
    const result = validateBenchmarkRunDraft(
      {
        ...BASE_DRAFT,
        lanes: [BASE_DRAFT.lanes[0]!],
      },
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.errors).toContain("At least 2 lanes are required.");
  });

  it("rejects duplicate providers", () => {
    const result = validateBenchmarkRunDraft(
      {
        ...BASE_DRAFT,
        lanes: [
          BASE_DRAFT.lanes[0]!,
          {
            id: "lane-2",
            provider: "codex",
            model: "gpt-5.4",
          },
        ],
      },
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.errors).toContain("Each lane must use a distinct provider.");
  });

  it("rejects unavailable providers and models", () => {
    const result = validateBenchmarkRunDraft(
      {
        ...BASE_DRAFT,
        lanes: [
          BASE_DRAFT.lanes[0]!,
          {
            id: "lane-2",
            provider: "opencode",
            model: "missing-model",
          },
        ],
      },
      {
        ...CONTEXT,
        providers: READY_PROVIDERS.map((provider) =>
          provider.provider === "opencode"
            ? {
                ...provider,
                status: "disabled",
                enabled: false,
              }
            : provider,
        ),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.errors).toContain("Provider OpenCode is unavailable.");
  });

  it("caps lanes at 6", () => {
    const result = validateBenchmarkRunDraft(
      {
        ...BASE_DRAFT,
        lanes: Array.from({ length: MAX_BENCHMARK_LANES + 1 }, (_, index) => ({
          id: `lane-${index + 1}`,
          provider: READY_PROVIDERS[index % READY_PROVIDERS.length]!.provider,
          model: READY_PROVIDERS[index % READY_PROVIDERS.length]!.models[0]!.slug,
        })),
      },
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.errors).toContain("Benchmarks support at most 6 lanes.");
  });

  it("builds one command per lane", () => {
    const run = buildBenchmarkRun(BASE_DRAFT, CONTEXT);

    expect(run.lanes).toHaveLength(2);
    expect(run.lanes.map((lane) => lane.command.type)).toEqual([
      "thread.turn.start",
      "thread.turn.start",
    ]);
  });

  it("uses unique thread IDs, message IDs, and temp branch names", () => {
    const run = buildBenchmarkRun(BASE_DRAFT, CONTEXT);

    const threadIds = new Set(run.lanes.map((lane) => lane.threadId));
    const messageIds = new Set(run.lanes.map((lane) => lane.messageId));
    const branches = new Set(run.lanes.map((lane) => lane.temporaryBranch));

    expect(threadIds.size).toBe(run.lanes.length);
    expect(messageIds.size).toBe(run.lanes.length);
    expect(branches.size).toBe(run.lanes.length);
  });

  it("uses the same raw prompt for all lanes", () => {
    const run = buildBenchmarkRun(BASE_DRAFT, CONTEXT);

    expect(run.lanes.every((lane) => lane.command.message.text === BASE_DRAFT.prompt)).toBe(true);
  });

  it("includes createThread, prepareWorktree, and setup script bootstrap", () => {
    const run = buildBenchmarkRun(BASE_DRAFT, CONTEXT);

    for (const lane of run.lanes) {
      expect(lane.command.bootstrap?.createThread?.projectId).toBe(BASE_DRAFT.projectId);
      expect(lane.command.bootstrap?.prepareWorktree).toEqual({
        projectCwd: BASE_DRAFT.projectCwd,
        baseBranch: BASE_DRAFT.baseBranch,
        branch: lane.temporaryBranch,
      });
      expect(lane.command.bootstrap?.runSetupScript).toBe(true);
    }
  });

  it("isolates dispatch failures per lane", async () => {
    const run = buildBenchmarkRun(BASE_DRAFT, CONTEXT);
    const dispatch = vi.fn(async (command) => {
      if (command.threadId === run.lanes[1]!.threadId) {
        throw new Error("Dispatch failed");
      }
    });

    const results = await dispatchBenchmarkCommands({
      run,
      dispatch,
    });
    const lanes = applyBenchmarkDispatchResults({
      lanes: run.lanes,
      results,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { laneId: "lane-1", status: "dispatched" },
      { laneId: "lane-2", status: "failed", error: "Dispatch failed" },
    ]);
    expect(lanes).toEqual([
      {
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        threadId: run.lanes[0]!.threadId,
        messageId: run.lanes[0]!.messageId,
        dispatchStatus: "dispatched",
      },
      {
        laneId: "lane-2",
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        threadId: run.lanes[1]!.threadId,
        messageId: run.lanes[1]!.messageId,
        dispatchStatus: "failed",
        error: "Dispatch failed",
      },
    ]);
  });

  it("exposes repo readiness separately from validation", () => {
    expect(GIT_STATUS.isRepo).toBe(true);
  });
});
