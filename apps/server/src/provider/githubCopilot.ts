/**
 * githubCopilot – Shared helpers for the GitHub Copilot provider harness.
 *
 * Provides SDK bootstrap in local-CLI mode, stable session-id derivation,
 * auth-status normalization, model/capability normalization, and tool
 * classifiers for the Copilot SDK integration.
 *
 * @module githubCopilot
 */
import type {
  GitHubCopilotSettings,
  ModelCapabilities,
  ServerProviderModel,
} from "@t3tools/contracts";
import { providerModelsFromSettings } from "./providerSnapshot";

// ── Capabilities ──────────────────────────────────────────────────────

const DEFAULT_GITHUB_COPILOT_REASONING_VARIANTS = ["low", "medium", "high", "xhigh"] as const;

function formatReasoningEffortLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

export function buildGitHubCopilotReasoningCapabilities(
  variants: ReadonlyArray<string> = DEFAULT_GITHUB_COPILOT_REASONING_VARIANTS,
  defaultVariant = "medium",
): ModelCapabilities {
  const normalizedVariants = variants
    .map((variant) => variant.trim())
    .filter((variant, index, values) => variant.length > 0 && values.indexOf(variant) === index);
  const effectiveVariants =
    normalizedVariants.length > 0
      ? normalizedVariants
      : [...DEFAULT_GITHUB_COPILOT_REASONING_VARIANTS];

  return {
    reasoningEffortLevels: effectiveVariants.map((variant) => {
      const option: { value: string; label: string; isDefault?: true } = {
        value: variant,
        label: formatReasoningEffortLabel(variant),
      };
      if (variant === defaultVariant) {
        option.isDefault = true;
      }
      return option;
    }),
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

export const GITHUB_COPILOT_REASONING_CAPABILITIES: ModelCapabilities =
  buildGitHubCopilotReasoningCapabilities();

export const GITHUB_COPILOT_EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

// ── Built-in models ───────────────────────────────────────────────────

export const GITHUB_COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: GITHUB_COPILOT_REASONING_CAPABILITIES,
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: GITHUB_COPILOT_REASONING_CAPABILITIES,
  },
];

// ── Model resolution ──────────────────────────────────────────────────

export function resolveGitHubCopilotModels(
  settings: GitHubCopilotSettings,
  discoveredModels?: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const baseModels =
    discoveredModels && discoveredModels.length > 0
      ? discoveredModels
      : GITHUB_COPILOT_BUILT_IN_MODELS;

  return providerModelsFromSettings(
    baseModels,
    "githubCopilot",
    settings.customModels,
    GITHUB_COPILOT_EMPTY_CAPABILITIES,
  );
}

// ── Stable session id ─────────────────────────────────────────────────

export function stableSessionId(threadId: string): string {
  return `t3-copilot-${threadId}`;
}

// ── Tool classifiers ──────────────────────────────────────────────────

const COMMAND_TOOL_NAMES = new Set(["run_command", "shell", "terminal", "exec"]);
const FILE_READ_TOOL_NAMES = new Set(["read_file", "search_files", "list_directory"]);
const FILE_CHANGE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "create_file",
  "delete_file",
  "apply_patch",
]);
const WEB_SEARCH_TOOL_NAMES = new Set(["web_search", "browse"]);

export type CopilotToolCategory =
  | "command"
  | "file-read"
  | "file-change"
  | "web-search"
  | "dynamic-tool";

export function classifyTool(toolName: string): CopilotToolCategory {
  const normalized = toolName.toLowerCase().trim();
  if (COMMAND_TOOL_NAMES.has(normalized)) return "command";
  if (FILE_READ_TOOL_NAMES.has(normalized)) return "file-read";
  if (FILE_CHANGE_TOOL_NAMES.has(normalized)) return "file-change";
  if (WEB_SEARCH_TOOL_NAMES.has(normalized)) return "web-search";
  return "dynamic-tool";
}

// ── Auth-status normalization ─────────────────────────────────────────

export type CopilotAuthStatus =
  | {
      readonly status: "authenticated";
      readonly label?: string;
      readonly type?: string;
      readonly message?: string;
    }
  | {
      readonly status: "unauthenticated";
      readonly type?: string;
      readonly message: string;
    }
  | {
      readonly status: "unknown";
      readonly type?: string;
      readonly message: string;
    };

function formatCopilotAuthType(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  switch (normalized) {
    case undefined:
    case "":
      return undefined;
    case "user":
      return "GitHub Copilot Account";
    case "env":
      return "Environment Token";
    case "gh-cli":
      return "GitHub CLI";
    case "hmac":
      return "HMAC";
    case "api-key":
      return "API Key";
    case "token":
      return "Token";
    default:
      return normalized
        .split(/[-_\s]+/g)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(" ");
  }
}

export function normalizeAuthStatus(input: {
  readonly authenticated?: boolean;
  readonly user?: string | null;
  readonly authType?: string | null;
  readonly error?: string | null;
  readonly statusMessage?: string | null;
}): CopilotAuthStatus {
  const type = formatCopilotAuthType(input.authType);
  const label = input.user?.trim() || (input.authType === "env" ? type : undefined);
  const message = input.statusMessage?.trim() || undefined;

  if (input.authenticated === true) {
    return {
      status: "authenticated",
      ...(label ? { label } : {}),
      ...(type ? { type } : {}),
      ...(message ? { message } : {}),
    };
  }
  if (input.authenticated === false) {
    return {
      status: "unauthenticated",
      ...(type ? { type } : {}),
      message:
        input.error ??
        message ??
        "GitHub Copilot CLI is available but not authenticated. Run `copilot login` and try again.",
    };
  }
  return {
    status: "unknown",
    ...(type ? { type } : {}),
    message: input.error ?? message ?? "Could not determine Copilot authentication status.",
  };
}

// ── Resume cursor ─────────────────────────────────────────────────────

export interface CopilotResumeCursor {
  readonly sessionId?: string;
  readonly cwd?: string;
}

export function readResumeCursor(resumeCursor: unknown): CopilotResumeCursor | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }

  const record = resumeCursor as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  const cwd = typeof record.cwd === "string" ? record.cwd : undefined;

  if (!sessionId && !cwd) return undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
  };
}
