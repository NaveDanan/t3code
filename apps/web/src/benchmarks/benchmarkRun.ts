import {
  type ClientOrchestrationCommand,
  type EnvironmentId,
  type GitStatusResult,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderModelOptions,
  type ProviderKind,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";

import { getComposerProviderState } from "../components/chat/composerProviderRegistry";
import { buildTemporaryWorktreeBranchName } from "../components/ChatView.logic";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { getCustomModelOptionsByProvider } from "../modelSelection";
import { resolveAppModelSelection } from "../modelSelection";
import { getProviderModels } from "../providerModels";
import { PROVIDER_OPTIONS } from "../session-logic";
import type { Project } from "../types";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

export type BenchmarkLaneConfig = {
  id: string;
  provider: ProviderKind;
  model: string;
};

export type BenchmarkLaneRun = {
  laneId: string;
  provider: ProviderKind;
  model: string;
  threadId: ThreadId;
  messageId: MessageId;
  dispatchStatus: "pending" | "dispatched" | "failed";
  error?: string;
};

export type BenchmarkRunDraft = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectCwd: string;
  baseBranch: string;
  prompt: string;
  runtimeMode: RuntimeMode;
  lanes: BenchmarkLaneConfig[];
};

export type BenchmarkLaneDispatchResult =
  | {
      laneId: string;
      status: "dispatched";
    }
  | {
      laneId: string;
      status: "failed";
      error: string;
    };

export type BenchmarkValidationResult =
  | {
      ok: true;
      prompt: string;
      baseBranch: string;
      lanes: BenchmarkLaneConfig[];
    }
  | {
      ok: false;
      errors: string[];
    };

export type BenchmarkBuildContext = {
  project: Pick<Project, "id" | "cwd" | "defaultModelSelection">;
  providers: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
};

export type PreparedBenchmarkLane = {
  config: BenchmarkLaneConfig;
  threadId: ThreadId;
  messageId: MessageId;
  temporaryBranch: string;
  command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
};

export type PreparedBenchmarkRun = {
  prompt: string;
  baseBranch: string;
  lanes: PreparedBenchmarkLane[];
};

const MIN_BENCHMARK_LANES = 2;
export const MAX_BENCHMARK_LANES = 6;

type BenchmarkDispatchModelOptions = Partial<ProviderModelOptions>;

const PROVIDER_LABEL_BY_KIND = new Map(
  PROVIDER_OPTIONS.filter((option) => option.available).map((option) => [
    option.value,
    option.label,
  ]),
);

function laneModelOptionsForValidation(input: {
  settings: UnifiedSettings;
  providers: ReadonlyArray<ServerProvider>;
  lane: BenchmarkLaneConfig;
}) {
  return getCustomModelOptionsByProvider(
    input.settings,
    input.providers,
    input.lane.provider,
    input.lane.model,
  )[input.lane.provider];
}

function resolveLaneModelSelection(input: {
  provider: ProviderKind;
  model: string;
  prompt: string;
  providers: ReadonlyArray<ServerProvider>;
  modelOptions?: BenchmarkDispatchModelOptions;
}): ModelSelection {
  const models = getProviderModels(input.providers, input.provider);
  const selectedProviderState = getComposerProviderState({
    provider: input.provider,
    model: input.model,
    models,
    prompt: input.prompt,
    modelOptions: input.modelOptions,
  });

  return {
    provider: input.provider,
    model: input.model,
    ...(selectedProviderState.modelOptionsForDispatch
      ? { options: selectedProviderState.modelOptionsForDispatch }
      : {}),
  } as ModelSelection;
}

function formatBenchmarkError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to dispatch benchmark lane.";
}

function providerLabel(provider: ProviderKind): string {
  return PROVIDER_LABEL_BY_KIND.get(provider) ?? provider;
}

function uniqueLaneConfigs(lanes: ReadonlyArray<BenchmarkLaneConfig>): BenchmarkLaneConfig[] {
  const seen = new Set<string>();
  const unique: BenchmarkLaneConfig[] = [];
  for (const lane of lanes) {
    if (!lane.id || seen.has(lane.id)) {
      continue;
    }
    seen.add(lane.id);
    unique.push(lane);
  }
  return unique;
}

export function validateBenchmarkRunDraft(
  draft: BenchmarkRunDraft,
  context: BenchmarkBuildContext,
): BenchmarkValidationResult {
  const prompt = draft.prompt.trim();
  const baseBranch = draft.baseBranch.trim();
  const lanes = uniqueLaneConfigs(draft.lanes);
  const errors: string[] = [];

  if (prompt.length === 0) {
    errors.push("Prompt is required.");
  }

  if (baseBranch.length === 0) {
    errors.push("Base branch is required.");
  }

  if (lanes.length < MIN_BENCHMARK_LANES) {
    errors.push("At least 2 lanes are required.");
  }

  if (lanes.length > MAX_BENCHMARK_LANES) {
    errors.push("Benchmarks support at most 6 lanes.");
  }

  const seenProviders = new Set<ProviderKind>();
  for (const lane of lanes) {
    if (seenProviders.has(lane.provider)) {
      errors.push("Each lane must use a distinct provider.");
      break;
    }
    seenProviders.add(lane.provider);

    const providerStatus = context.providers.find(
      (provider) => provider.provider === lane.provider,
    );
    if (!providerStatus || !providerStatus.enabled || providerStatus.status !== "ready") {
      errors.push(`Provider ${providerLabel(lane.provider)} is unavailable.`);
      continue;
    }

    const availableOptions = laneModelOptionsForValidation({
      settings: context.settings,
      providers: context.providers,
      lane,
    });
    if (!availableOptions.some((option) => option.slug === lane.model)) {
      errors.push(`Model ${lane.model} is unavailable for ${providerLabel(lane.provider)}.`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    prompt,
    baseBranch,
    lanes,
  };
}

export function canRunBenchmarkDraft(input: {
  draft: BenchmarkRunDraft;
  context: BenchmarkBuildContext;
  gitStatus: GitStatusResult | null;
}): boolean {
  if (input.gitStatus?.isRepo !== true) {
    return false;
  }
  return validateBenchmarkRunDraft(input.draft, input.context).ok;
}

export function buildBenchmarkRun(
  draft: BenchmarkRunDraft,
  context: BenchmarkBuildContext,
): PreparedBenchmarkRun {
  const validation = validateBenchmarkRunDraft(draft, context);
  if (!validation.ok) {
    throw new Error(validation.errors[0] ?? "Invalid benchmark run.");
  }

  const lanes = validation.lanes.map((lane) => {
    const model = resolveAppModelSelection(
      lane.provider,
      context.settings,
      context.providers,
      lane.model,
    );
    const modelSelection = resolveLaneModelSelection({
      provider: lane.provider,
      model,
      prompt: validation.prompt,
      providers: context.providers,
      modelOptions: {
        [lane.provider]:
          context.project.defaultModelSelection?.provider === lane.provider
            ? context.project.defaultModelSelection.options
            : undefined,
      },
    });
    const threadId = newThreadId();
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    const temporaryBranch = buildTemporaryWorktreeBranchName();
    const titleSeed = `Benchmark · ${providerLabel(lane.provider)} · ${model}`;

    return {
      config: {
        ...lane,
        model,
      },
      threadId,
      messageId,
      temporaryBranch,
      command: {
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId,
          role: "user",
          text: validation.prompt,
          attachments: [],
        },
        modelSelection,
        titleSeed,
        runtimeMode: draft.runtimeMode,
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: context.project.id,
            title: titleSeed,
            modelSelection,
            runtimeMode: draft.runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
          prepareWorktree: {
            projectCwd: draft.projectCwd,
            baseBranch: validation.baseBranch,
            branch: temporaryBranch,
          },
          runSetupScript: true,
        },
        createdAt,
      },
    } satisfies PreparedBenchmarkLane;
  });

  return {
    prompt: validation.prompt,
    baseBranch: validation.baseBranch,
    lanes,
  };
}

export async function dispatchBenchmarkCommands(input: {
  run: PreparedBenchmarkRun;
  dispatch: (
    command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>,
  ) => Promise<unknown>;
}): Promise<BenchmarkLaneDispatchResult[]> {
  const settled = await Promise.allSettled(
    input.run.lanes.map(async (lane) => {
      await input.dispatch(lane.command);
      return lane.config.id;
    }),
  );

  return settled.map((result, index) => {
    const laneId = input.run.lanes[index]!.config.id;
    if (result.status === "fulfilled") {
      return {
        laneId,
        status: "dispatched",
      } satisfies BenchmarkLaneDispatchResult;
    }
    return {
      laneId,
      status: "failed",
      error: formatBenchmarkError(result.reason),
    } satisfies BenchmarkLaneDispatchResult;
  });
}

export function applyBenchmarkDispatchResults(input: {
  lanes: ReadonlyArray<PreparedBenchmarkLane>;
  results: ReadonlyArray<BenchmarkLaneDispatchResult>;
}): BenchmarkLaneRun[] {
  const resultByLaneId = new Map(input.results.map((result) => [result.laneId, result]));

  return input.lanes.map((lane) => {
    const result = resultByLaneId.get(lane.config.id);
    if (!result) {
      return {
        laneId: lane.config.id,
        provider: lane.config.provider,
        model: lane.config.model,
        threadId: lane.threadId,
        messageId: lane.messageId,
        dispatchStatus: "pending",
      } satisfies BenchmarkLaneRun;
    }

    if (result.status === "dispatched") {
      return {
        laneId: lane.config.id,
        provider: lane.config.provider,
        model: lane.config.model,
        threadId: lane.threadId,
        messageId: lane.messageId,
        dispatchStatus: "dispatched",
      } satisfies BenchmarkLaneRun;
    }

    return {
      laneId: lane.config.id,
      provider: lane.config.provider,
      model: lane.config.model,
      threadId: lane.threadId,
      messageId: lane.messageId,
      dispatchStatus: "failed",
      error: result.error,
    } satisfies BenchmarkLaneRun;
  });
}
