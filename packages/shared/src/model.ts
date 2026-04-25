import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ClaudeCodeEffort,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorAgentModelOptions,
  type ForgeCodeModelOptions,
  type GitHubCopilotModelOptions,
  type ModelCapabilities,
  type ModelSelection,
  type OpencodeModelOptions,
  type ProviderKind,
} from "@t3tools/contracts";

export interface SelectableModelOption {
  slug: string;
  name: string;
}

const CURSOR_AGENT_EFFORT_SUFFIXES = [
  ["-extra-high", "xhigh"],
  ["-xhigh", "xhigh"],
  ["-high", "high"],
  ["-medium", "medium"],
  ["-low", "low"],
  ["-minimal", "minimal"],
  ["-none", "none"],
  ["-max", "max"],
] as const;

function normalizeCursorAgentVariantSlug(model: string): string {
  let base = model.trim();
  if (!base || base === "auto") {
    return base;
  }

  let changed = true;
  while (changed) {
    changed = false;

    if (base.endsWith("-fast")) {
      base = base.slice(0, -"-fast".length);
      changed = true;
    }

    if (base.endsWith("-thinking")) {
      base = base.slice(0, -"-thinking".length);
      changed = true;
    }

    for (const [suffix] of CURSOR_AGENT_EFFORT_SUFFIXES) {
      if (!base.endsWith(suffix)) {
        continue;
      }
      base = base.slice(0, -suffix.length);
      changed = true;
      break;
    }
  }

  return base;
}

// ── Effort helpers ────────────────────────────────────────────────────

/** Check whether a capabilities object includes a given effort value. */
export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

/** Return the default effort value for a capabilities object, or null if none. */
export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

/**
 * Resolve a raw effort option against capabilities.
 *
 * Returns the effective effort value — the explicit value if supported and not
 * prompt-injected, otherwise the model's default. Returns `undefined` only
 * when the model has no effort levels at all.
 *
 * Prompt-injected efforts (e.g. "ultrathink") are excluded because they are
 * applied via prompt text, not the effort API parameter.
 */
export function resolveEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultEffort(caps);
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  if (
    trimmed &&
    !caps.promptInjectedEffortLevels.includes(trimmed) &&
    hasEffortLevel(caps, trimmed)
  ) {
    return trimmed;
  }
  return defaultValue ?? undefined;
}

// ── Context window helpers ───────────────────────────────────────────

/** Check whether a capabilities object includes a given context window value. */
export function hasContextWindowOption(caps: ModelCapabilities, value: string): boolean {
  return caps.contextWindowOptions.some((o) => o.value === value);
}

/** Return the default context window value, or `null` if none is defined. */
export function getDefaultContextWindow(caps: ModelCapabilities): string | null {
  return caps.contextWindowOptions.find((o) => o.isDefault)?.value ?? null;
}

/**
 * Resolve a raw `contextWindow` option against capabilities.
 *
 * Returns the effective context window value — the explicit value if supported,
 * otherwise the model's default. Returns `undefined` only when the model has
 * no context window options at all.
 *
 * Unlike effort levels (where the API has matching defaults), the context
 * window requires an explicit API suffix (e.g. `[1m]`), so we always preserve
 * the resolved value to avoid ambiguity between "user chose the default" and
 * "not specified".
 */
export function resolveContextWindow(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultContextWindow(caps);
  if (!raw) return defaultValue ?? undefined;
  return hasContextWindowOption(caps, raw) ? raw : (defaultValue ?? undefined);
}

export function normalizeCodexModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort
      ? { reasoningEffort: reasoningEffort as CodexModelOptions["reasoningEffort"] }
      : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const effort = resolveEffort(caps, modelOptions?.effort);
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: ClaudeModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort ? { effort: effort as ClaudeModelOptions["effort"] } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeOpencodeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: OpencodeModelOptions | null | undefined,
): OpencodeModelOptions | undefined {
  const effort = resolveEffort(caps, modelOptions?.effort);
  const nextOptions: OpencodeModelOptions = effort
    ? { effort: effort as OpencodeModelOptions["effort"] }
    : {};
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeForgeCodeModelOptionsWithCapabilities(
  _caps: ModelCapabilities,
  _modelOptions: ForgeCodeModelOptions | null | undefined,
): ForgeCodeModelOptions | undefined {
  return undefined;
}

export function normalizeCursorAgentModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CursorAgentModelOptions | null | undefined,
): CursorAgentModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: CursorAgentModelOptions = {
    ...(reasoningEffort
      ? { reasoningEffort: reasoningEffort as CursorAgentModelOptions["reasoningEffort"] }
      : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeGitHubCopilotModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: GitHubCopilotModelOptions | null | undefined,
): GitHubCopilotModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  if (!reasoningEffort) return undefined;
  const nextOptions: GitHubCopilotModelOptions = {
    reasoningEffort: reasoningEffort as GitHubCopilotModelOptions["reasoningEffort"],
  };
  return nextOptions;
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] as Record<string, string>;
  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;

  const normalized = typeof aliased === "string" ? aliased : trimmed;
  return provider === "cursorAgent" ? normalizeCursorAgentVariantSlug(normalized) : normalized;
}

export function resolveSelectableModel(
  provider: ProviderKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);
  if (direct) {
    return direct.slug;
  }

  if (provider === "forgecode" && !trimmed.includes("/")) {
    const forgeMatches = options.filter((option) => option.slug.endsWith(`/${trimmed}`));
    if (forgeMatches.length === 1) {
      return forgeMatches[0]!.slug;
    }
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);
  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);
  return resolved ? resolved.slug : null;
}

export function resolveModelSlug(model: string | null | undefined, provider: ProviderKind): string {
  const normalized = normalizeModelSlug(model, provider);
  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider];
  }
  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

/**
 * Resolve the actual API model identifier from a model selection.
 *
 * Provider-aware: each provider can map `contextWindow` (or other options)
 * to whatever the API requires — a model-id suffix, a separate parameter, etc.
 * The canonical slug stored in the selection stays unchanged so the
 * capabilities system keeps working.
 *
 * Expects `contextWindow` to already be resolved (via `resolveContextWindow`)
 * to the effective value, not stripped to `undefined` for defaults.
 */
export function resolveApiModelId(modelSelection: ModelSelection): string {
  switch (modelSelection.provider) {
    case "claudeAgent": {
      switch (modelSelection.options?.contextWindow) {
        case "1m":
          return `${modelSelection.model}[1m]`;
        default:
          return modelSelection.model;
      }
    }
    default: {
      return modelSelection.model;
    }
  }
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeCodeEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
