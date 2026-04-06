import type {
  ClaudeModelOptions,
  CodexModelOptions,
  ForgeCodeModelOptions,
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
  provider: ProviderKind,
  model: string,
  options?: CodexModelOptions | ClaudeModelOptions | OpencodeModelOptions | ForgeCodeModelOptions,
): ModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: CodexModelOptions | ClaudeModelOptions | OpencodeModelOptions | ForgeCodeModelOptions,
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
  }
}
