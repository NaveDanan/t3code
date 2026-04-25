import type {
  ClaudeModelOptions,
  CodexModelOptions,
  CursorAgentModelOptions,
  ForgeCodeModelOptions,
  GitHubCopilotModelOptions,
  ModelSelection,
  OpencodeModelOptions,
  ProviderKind,
} from "@t3tools/contracts";

export function buildModelSelection(
  provider: "codex",
  model: string,
  options?: CodexModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: "claudeAgent",
  model: string,
  options?: ClaudeModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: "opencode",
  model: string,
  options?: OpencodeModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: "forgecode",
  model: string,
  options?: ForgeCodeModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: "cursorAgent",
  model: string,
  options?: CursorAgentModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: "githubCopilot",
  model: string,
  options?: GitHubCopilotModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?:
    | CodexModelOptions
    | ClaudeModelOptions
    | CursorAgentModelOptions
    | OpencodeModelOptions
    | ForgeCodeModelOptions
    | GitHubCopilotModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?:
    | CodexModelOptions
    | ClaudeModelOptions
    | CursorAgentModelOptions
    | OpencodeModelOptions
    | ForgeCodeModelOptions
    | GitHubCopilotModelOptions,
): ModelSelection {
  switch (provider) {
    case "codex":
      return options
        ? { provider, model, options: options as CodexModelOptions }
        : { provider, model };
    case "claudeAgent":
      return options
        ? { provider, model, options: options as ClaudeModelOptions }
        : { provider, model };
    case "opencode":
      return options
        ? { provider, model, options: options as OpencodeModelOptions }
        : { provider, model };
    case "forgecode":
      return options
        ? { provider, model, options: options as ForgeCodeModelOptions }
        : { provider, model };
    case "cursorAgent":
      return options
        ? { provider, model, options: options as CursorAgentModelOptions }
        : { provider, model };
    case "githubCopilot":
      return options
        ? { provider, model, options: options as GitHubCopilotModelOptions }
        : { provider, model };
  }
}
