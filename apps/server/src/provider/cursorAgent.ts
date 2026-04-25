/**
 * cursorAgent – Shared helpers for the Cursor CLI provider harness.
 *
 * Provides execution backend resolution, spawn spec construction, resume
 * cursor management, and model resolution for the `cursor-agent` headless
 * CLI integration.
 *
 * @module cursorAgent
 */
import type {
  ContextWindowOption,
  CursorAgentExecutionBackend,
  CursorAgentModelOptions,
  CursorAgentReasoningEffort,
  CursorAgentSettings,
  EffortOption,
  ModelCapabilities,
  ServerProviderModel,
} from "@t3tools/contracts";
import { CURSOR_AGENT_REASONING_EFFORT_OPTIONS } from "@t3tools/contracts";

import { providerModelsFromSettings } from "./providerSnapshot";
import { shellQuoteForPosix, toWslPath } from "./forgecode";

// ── Capabilities ──────────────────────────────────────────────────────

export const CURSOR_AGENT_EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

// ── Built-in models ───────────────────────────────────────────────────

export const CURSOR_AGENT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Auto",
    isCustom: false,
    capabilities: CURSOR_AGENT_EMPTY_CAPABILITIES,
  },
];

const CURSOR_AGENT_MODEL_LINE_RE = /^(\S+)\s+-\s+(.+)$/;

const CURSOR_AGENT_CONTEXT_RE = /\b(\d+(?:k|m))\b/i;
const CURSOR_AGENT_EFFORT_SUFFIXES = [
  ["-extra-high", "xhigh", "Extra High"],
  ["-xhigh", "xhigh", "Extra High"],
  ["-high", "high", "High"],
  ["-medium", "medium", "Medium"],
  ["-low", "low", "Low"],
  ["-minimal", "minimal", "Minimal"],
  ["-none", "none", "None"],
  ["-max", "max", "Max"],
] as const satisfies ReadonlyArray<readonly [string, CursorAgentReasoningEffort, string]>;

interface CursorAgentVariantDescriptor {
  readonly rawSlug: string;
  readonly name: string;
  readonly baseSlug: string;
  readonly baseName: string;
  readonly contextWindow?: string;
  readonly reasoningEffort?: CursorAgentReasoningEffort;
  readonly fastMode: boolean;
  readonly thinking: boolean;
  readonly order: number;
}

interface CursorAgentGroupedModelMeta {
  readonly defaultRawSlug: string;
  readonly defaultContextWindow?: string;
  readonly defaultReasoningEffort?: CursorAgentReasoningEffort;
  readonly defaultThinking: boolean;
  readonly defaultFastMode: boolean;
  readonly variants: ReadonlyArray<CursorAgentVariantDescriptor>;
}

let cursorAgentGroupedModelRegistry = new Map<string, CursorAgentGroupedModelMeta>();

function trimCursorModelName(name: string): string {
  return name.replace(/\s+\((?:current|default)(?:,\s*(?:current|default))*\)$/i, "").trim();
}

function parseCursorVariantFromSlug(slug: string): {
  readonly baseSlug: string;
  readonly reasoningEffort?: CursorAgentReasoningEffort;
  readonly fastMode: boolean;
  readonly thinking: boolean;
} {
  let baseSlug = slug;
  let reasoningEffort: CursorAgentReasoningEffort | undefined;
  let fastMode = false;
  let thinking = false;

  let changed = true;
  while (changed) {
    changed = false;

    if (baseSlug.endsWith("-fast")) {
      baseSlug = baseSlug.slice(0, -"-fast".length);
      fastMode = true;
      changed = true;
    }

    if (baseSlug.endsWith("-thinking")) {
      baseSlug = baseSlug.slice(0, -"-thinking".length);
      thinking = true;
      changed = true;
    }

    for (const [suffix, effort] of CURSOR_AGENT_EFFORT_SUFFIXES) {
      if (!baseSlug.endsWith(suffix)) {
        continue;
      }
      baseSlug = baseSlug.slice(0, -suffix.length);
      reasoningEffort = effort;
      changed = true;
      break;
    }
  }

  return {
    baseSlug,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    fastMode,
    thinking,
  };
}

function parseCursorVariantFromName(name: string): {
  readonly baseName: string;
  readonly contextWindow?: string;
  readonly reasoningEffort?: CursorAgentReasoningEffort;
  readonly fastMode: boolean;
  readonly thinking: boolean;
} {
  let baseName = trimCursorModelName(name);
  let fastMode = false;
  let thinking = false;
  let reasoningEffort: CursorAgentReasoningEffort | undefined;
  let contextWindow: string | undefined;

  let changed = true;
  while (changed) {
    changed = false;

    if (baseName.endsWith(" Fast")) {
      baseName = baseName.slice(0, -" Fast".length);
      fastMode = true;
      changed = true;
    }

    if (baseName.endsWith(" Thinking")) {
      baseName = baseName.slice(0, -" Thinking".length);
      thinking = true;
      changed = true;
    }

    for (const [, effort, label] of CURSOR_AGENT_EFFORT_SUFFIXES) {
      const suffix = ` ${label}`;
      if (!baseName.endsWith(suffix)) {
        continue;
      }
      baseName = baseName.slice(0, -suffix.length);
      reasoningEffort = effort;
      changed = true;
      break;
    }

    const contextMatch = baseName.match(CURSOR_AGENT_CONTEXT_RE);
    if (contextMatch && baseName.endsWith(` ${contextMatch[1]}`)) {
      baseName = baseName.slice(0, -` ${contextMatch[1]}`.length);
      contextWindow = contextMatch[1]?.toLowerCase();
      changed = true;
    }
  }

  return {
    baseName: baseName.trim(),
    ...(contextWindow ? { contextWindow } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    fastMode,
    thinking,
  };
}

function buildCursorVariantDescriptor(
  slug: string,
  name: string,
  order: number,
): CursorAgentVariantDescriptor {
  const parsedSlug = parseCursorVariantFromSlug(slug);
  const parsedName = parseCursorVariantFromName(name);

  return {
    rawSlug: slug,
    name,
    baseSlug: parsedSlug.baseSlug,
    baseName: parsedName.baseName,
    ...(parsedName.contextWindow ? { contextWindow: parsedName.contextWindow } : {}),
    ...((parsedSlug.reasoningEffort ?? parsedName.reasoningEffort)
      ? { reasoningEffort: parsedSlug.reasoningEffort ?? parsedName.reasoningEffort }
      : {}),
    fastMode: parsedSlug.fastMode || parsedName.fastMode,
    thinking: parsedSlug.thinking || parsedName.thinking,
    order,
  };
}

function scoreCursorDefaultVariant(variant: CursorAgentVariantDescriptor): number {
  return [
    variant.fastMode ? 1 : 0,
    variant.thinking ? 1 : 0,
    variant.reasoningEffort === undefined || variant.reasoningEffort === "medium" ? 0 : 1,
    variant.order,
  ].reduce((score, value, index) => score + value * 10 ** (3 - index), 0);
}

function formatCursorEffortLabel(value: CursorAgentReasoningEffort): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function buildCursorEffortOptions(
  variants: ReadonlyArray<CursorAgentVariantDescriptor>,
  defaultVariant: CursorAgentVariantDescriptor,
): ReadonlyArray<EffortOption> {
  const entries = new Map<CursorAgentReasoningEffort, EffortOption>();

  for (const variant of variants) {
    if (!variant.reasoningEffort) {
      continue;
    }
    if (!entries.has(variant.reasoningEffort)) {
      entries.set(variant.reasoningEffort, {
        value: variant.reasoningEffort,
        label: formatCursorEffortLabel(variant.reasoningEffort),
      });
    }
  }

  if (entries.size > 0 && defaultVariant.reasoningEffort === undefined && !entries.has("medium")) {
    entries.set("medium", {
      value: "medium",
      label: formatCursorEffortLabel("medium"),
      isDefault: true,
    });
  }

  if (defaultVariant.reasoningEffort === undefined && entries.has("medium")) {
    entries.set("medium", {
      value: "medium",
      label: formatCursorEffortLabel("medium"),
      isDefault: true,
    });
  }

  if (defaultVariant.reasoningEffort && entries.has(defaultVariant.reasoningEffort)) {
    entries.set(defaultVariant.reasoningEffort, {
      value: defaultVariant.reasoningEffort,
      label: formatCursorEffortLabel(defaultVariant.reasoningEffort),
      isDefault: true,
    });
  }

  return CURSOR_AGENT_REASONING_EFFORT_OPTIONS.flatMap((effort) => {
    const option = entries.get(effort);
    return option ? [option] : [];
  });
}

function buildCursorContextOptions(
  variants: ReadonlyArray<CursorAgentVariantDescriptor>,
  defaultVariant: CursorAgentVariantDescriptor,
): ReadonlyArray<ContextWindowOption> {
  const options = new Map<string, ContextWindowOption>();

  for (const variant of variants) {
    if (!variant.contextWindow) {
      continue;
    }
    const label = variant.contextWindow.toUpperCase();
    options.set(variant.contextWindow, {
      value: variant.contextWindow,
      label,
      ...(variant.contextWindow === defaultVariant.contextWindow ? { isDefault: true } : {}),
    });
  }

  return [...options.values()];
}

function buildCursorGroupedModelMeta(
  variants: ReadonlyArray<CursorAgentVariantDescriptor>,
): CursorAgentGroupedModelMeta {
  const defaultVariant = [...variants].toSorted(
    (left, right) => scoreCursorDefaultVariant(left) - scoreCursorDefaultVariant(right),
  )[0]!;
  const effortOptions = buildCursorEffortOptions(variants, defaultVariant);
  const defaultReasoningEffort =
    defaultVariant.reasoningEffort ??
    (effortOptions.find((option) => option.isDefault)?.value as
      | CursorAgentReasoningEffort
      | undefined);

  return {
    defaultRawSlug: defaultVariant.rawSlug,
    ...(defaultVariant.contextWindow ? { defaultContextWindow: defaultVariant.contextWindow } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    defaultThinking: defaultVariant.thinking,
    defaultFastMode: defaultVariant.fastMode,
    variants,
  };
}

function buildCursorCapabilities(
  variants: ReadonlyArray<CursorAgentVariantDescriptor>,
): ModelCapabilities {
  const defaultVariant = [...variants].toSorted(
    (left, right) => scoreCursorDefaultVariant(left) - scoreCursorDefaultVariant(right),
  )[0]!;

  return {
    reasoningEffortLevels: buildCursorEffortOptions(variants, defaultVariant),
    supportsFastMode: variants.some((variant) => variant.fastMode),
    supportsThinkingToggle:
      variants.some((variant) => variant.thinking) && variants.some((variant) => !variant.thinking),
    contextWindowOptions: buildCursorContextOptions(variants, defaultVariant),
    promptInjectedEffortLevels: [],
  };
}

function matchesCursorVariantEffort(
  variant: CursorAgentVariantDescriptor,
  desiredEffort: CursorAgentReasoningEffort | undefined,
  meta: CursorAgentGroupedModelMeta,
): boolean {
  const normalizedVariantEffort = variant.reasoningEffort ?? meta.defaultReasoningEffort;
  return desiredEffort === undefined || normalizedVariantEffort === desiredEffort;
}

export function resolveCursorAgentApiModelId(input: {
  readonly model: string;
  readonly options: CursorAgentModelOptions | undefined;
}): string {
  const meta = cursorAgentGroupedModelRegistry.get(input.model);
  if (!meta) {
    return input.model;
  }

  const desiredContextWindow =
    input.options?.contextWindow?.trim().toLowerCase() || meta.defaultContextWindow;
  const desiredEffort = input.options?.reasoningEffort ?? meta.defaultReasoningEffort;
  const desiredFastMode = input.options?.fastMode ?? meta.defaultFastMode;
  const desiredThinking = input.options?.thinking ?? meta.defaultThinking;

  const candidate = [...meta.variants].toSorted((left, right) => {
    const leftScore =
      (left.contextWindow === desiredContextWindow ? 0 : 8) +
      (matchesCursorVariantEffort(left, desiredEffort, meta) ? 0 : 4) +
      (left.thinking === desiredThinking ? 0 : 2) +
      (left.fastMode === desiredFastMode ? 0 : 1) +
      left.order / 1000;
    const rightScore =
      (right.contextWindow === desiredContextWindow ? 0 : 8) +
      (matchesCursorVariantEffort(right, desiredEffort, meta) ? 0 : 4) +
      (right.thinking === desiredThinking ? 0 : 2) +
      (right.fastMode === desiredFastMode ? 0 : 1) +
      right.order / 1000;
    return leftScore - rightScore;
  })[0];

  return candidate?.rawSlug ?? meta.defaultRawSlug;
}

export function parseCursorAgentModelsOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const groupedVariants = new Map<string, CursorAgentVariantDescriptor[]>();

  let order = 0;
  for (const rawLine of output.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.toLowerCase() === "available models" || line.startsWith("Tip:")) {
      continue;
    }

    const match = line.match(CURSOR_AGENT_MODEL_LINE_RE);
    if (!match) {
      continue;
    }

    const slug = match[1]?.trim();
    const name = trimCursorModelName(match[2] ?? "");
    if (!slug || !name) {
      continue;
    }

    const descriptor = buildCursorVariantDescriptor(slug, name, order);
    const variants = groupedVariants.get(descriptor.baseSlug) ?? [];
    variants.push(descriptor);
    groupedVariants.set(descriptor.baseSlug, variants);
    order += 1;
  }

  const nextRegistry = new Map<string, CursorAgentGroupedModelMeta>();
  const discoveredModels = [...groupedVariants.entries()]
    .map(([baseSlug, variants]) => {
      const meta = buildCursorGroupedModelMeta(variants);
      nextRegistry.set(baseSlug, meta);

      return {
        slug: baseSlug,
        name: variants[0]!.baseName,
        isCustom: false,
        capabilities: buildCursorCapabilities(variants),
      } satisfies ServerProviderModel;
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));

  cursorAgentGroupedModelRegistry = nextRegistry;

  return discoveredModels;
}

// ── Model resolution ──────────────────────────────────────────────────

export function resolveCursorAgentModels(
  settings: CursorAgentSettings,
  discoveredModels?: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const baseModels =
    discoveredModels && discoveredModels.length > 0
      ? discoveredModels
      : CURSOR_AGENT_BUILT_IN_MODELS;

  return providerModelsFromSettings(
    baseModels,
    "cursorAgent",
    settings.customModels,
    CURSOR_AGENT_EMPTY_CAPABILITIES,
  );
}

// ── Execution backend ─────────────────────────────────────────────────

export interface CursorExecutionTarget {
  readonly executionBackend: CursorAgentExecutionBackend;
  readonly wslDistro?: string;
}

export function cursorExecutionBackendLabel(executionBackend: CursorAgentExecutionBackend): string {
  switch (executionBackend) {
    case "native":
      return "Native";
    case "wsl":
      return "WSL";
  }
}

export function defaultCursorExecutionBackendForHost(): CursorAgentExecutionBackend {
  return process.platform === "win32" ? "wsl" : "native";
}

export function supportedCursorExecutionBackends(): ReadonlyArray<CursorAgentExecutionBackend> {
  return process.platform === "win32" ? ["wsl", "native"] : ["native"];
}

// ── Spawn spec ────────────────────────────────────────────────────────

export interface CursorSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly shell: boolean;
}

function shouldUseNativeCursorShell(): boolean {
  return process.platform === "win32";
}

function buildCursorCommandLine(input: {
  readonly binaryPath: string;
  readonly cursorArgs: ReadonlyArray<string>;
}): string {
  const binaryPath = input.binaryPath.trim() || "cursor-agent";
  return [shellQuoteForPosix(binaryPath), ...input.cursorArgs.map(shellQuoteForPosix)].join(" ");
}

function buildCursorWslShellCommand(input: {
  readonly binaryPath: string;
  readonly cursorArgs: ReadonlyArray<string>;
  readonly cwd?: string;
}): string {
  const command = buildCursorCommandLine(input);
  return input.cwd ? `cd ${shellQuoteForPosix(toWslPath(input.cwd))} && ${command}` : command;
}

export function buildCursorWslSpawnSpec(input: {
  readonly binaryPath: string;
  readonly cursorArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly wslDistro?: string;
}): CursorSpawnSpec {
  const baseArgs =
    input.wslDistro && input.wslDistro.trim().length > 0
      ? ["--distribution", input.wslDistro.trim()]
      : [];
  return {
    command: "wsl.exe",
    args: [...baseArgs, "sh", "-lc", buildCursorWslShellCommand(input)],
    env: process.env,
    shell: false,
    cwd: undefined,
  };
}

function buildCursorNativeSpawnSpec(input: {
  readonly binaryPath: string;
  readonly cursorArgs: ReadonlyArray<string>;
  readonly cwd?: string;
}): CursorSpawnSpec {
  const binaryPath = input.binaryPath.trim() || "cursor-agent";
  return {
    command: binaryPath,
    args: [...input.cursorArgs],
    env: process.env,
    shell: shouldUseNativeCursorShell(),
    cwd: input.cwd,
  };
}

export function buildCursorSpawnSpec(input: {
  readonly binaryPath: string;
  readonly cursorArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly executionTarget: CursorExecutionTarget;
}): CursorSpawnSpec {
  switch (input.executionTarget.executionBackend) {
    case "native":
      return buildCursorNativeSpawnSpec({
        binaryPath: input.binaryPath,
        cursorArgs: input.cursorArgs,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    case "wsl":
      return buildCursorWslSpawnSpec({
        binaryPath: input.binaryPath,
        cursorArgs: input.cursorArgs,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.executionTarget.wslDistro ? { wslDistro: input.executionTarget.wslDistro } : {}),
      });
  }
}

// ── Adapter key ───────────────────────────────────────────────────────

export function buildCursorAdapterKey(target: CursorExecutionTarget): string {
  switch (target.executionBackend) {
    case "native":
      return "cursorAgent:native";
    case "wsl":
      return `cursorAgent:wsl:${target.wslDistro?.trim() || "default"}`;
  }
}

export function parseCursorAdapterKey(
  adapterKey: string | null | undefined,
): CursorExecutionTarget | null {
  if (typeof adapterKey !== "string") {
    return null;
  }
  const trimmed = adapterKey.trim();
  if (trimmed === "cursorAgent:native") {
    return { executionBackend: "native" };
  }
  const wslMatch = trimmed.match(/^cursorAgent:wsl:(.+)$/);
  if (!wslMatch) {
    return null;
  }
  const distro = wslMatch[1]?.trim();
  return {
    executionBackend: "wsl",
    ...(distro && distro !== "default" ? { wslDistro: distro } : {}),
  };
}

// ── Resume cursor ─────────────────────────────────────────────────────

export interface CursorResumeCursor {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly executionBackend?: CursorAgentExecutionBackend;
  readonly wslDistro?: string;
}

export function readCursorResumeCursor(resumeCursor: unknown): CursorResumeCursor | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim().length > 0
      ? record.sessionId.trim()
      : undefined;
  const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
  const executionBackend =
    record.executionBackend === "native" || record.executionBackend === "wsl"
      ? record.executionBackend
      : undefined;
  const wslDistro = typeof record.wslDistro === "string" ? record.wslDistro : undefined;

  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(executionBackend ? { executionBackend } : {}),
    ...(wslDistro ? { wslDistro } : {}),
  };
}

// ── Turn CLI args ─────────────────────────────────────────────────────

export function buildCursorTurnArgs(input: {
  readonly prompt: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly outputFormat: "stream-json" | "json";
}): ReadonlyArray<string> {
  const args: string[] = ["-p", input.prompt, "--output-format", input.outputFormat];
  if (input.model && input.model !== "auto") {
    args.push("--model", input.model);
  }
  if (input.sessionId) {
    args.push("--resume", input.sessionId);
  }
  return args;
}

// ── Stable session id ─────────────────────────────────────────────────

export function stableCursorSessionId(threadId: string): string {
  return `t3-cursor-${threadId}`;
}
