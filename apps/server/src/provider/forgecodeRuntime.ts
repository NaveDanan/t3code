import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ProviderInteractionMode,
  ThreadTokenUsageSnapshot,
  ToolLifecycleItemType,
} from "@t3tools/contracts";

import type { ForgeCliApi } from "./forgecode.ts";
import {
  normalizeForgeConversationText,
  parseForgeConversationDump,
  type ForgeParsedConversationDump,
} from "./forgecodeDump.ts";

export const DEFAULT_FORGE_DUMP_ROOT_PATH = join(tmpdir(), "t3code-forge-dumps");

export function createForgeConversationId(): string {
  return randomUUID();
}

export function forgeAgentIdForInteractionMode(
  interactionMode: ProviderInteractionMode | undefined,
): "forge" | "muse" {
  return interactionMode === "plan" ? "muse" : "forge";
}

async function readNewestDumpFile(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => join(directory, entry.name));
  if (jsonFiles.length === 0) {
    throw new Error(`Forge did not produce a dump file in '${directory}'.`);
  }

  const sorted = await Promise.all(
    jsonFiles.map(async (path) => ({
      path,
      stat: await stat(path),
    })),
  );

  const newest = sorted.toSorted((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
  if (!newest) {
    throw new Error(`Forge did not produce a readable dump file in '${directory}'.`);
  }

  return readFile(newest.path, "utf8");
}

export async function dumpForgeConversation(input: {
  readonly binaryPath: string;
  readonly conversationId: string;
  readonly cliApi: ForgeCliApi;
  readonly dumpRootPath?: string;
}): Promise<ForgeParsedConversationDump> {
  const dumpRootPath = input.dumpRootPath ?? DEFAULT_FORGE_DUMP_ROOT_PATH;
  await mkdir(dumpRootPath, { recursive: true });
  const dumpDirectory = await mkdtemp(join(dumpRootPath, "conversation-"));

  try {
    await input.cliApi.run({
      binaryPath: input.binaryPath,
      cwd: dumpDirectory,
      args: ["conversation", "dump", input.conversationId],
    });
    const dumpRaw = await readNewestDumpFile(dumpDirectory);
    return parseForgeConversationDump(dumpRaw);
  } finally {
    await rm(dumpDirectory, { recursive: true, force: true });
  }
}

export function normalizeForgeConversationShowText(raw: string): string | undefined {
  return normalizeForgeConversationText(raw);
}

export async function showForgeConversationMessage(input: {
  readonly binaryPath: string;
  readonly conversationId: string;
  readonly cliApi: ForgeCliApi;
}): Promise<string | undefined> {
  const result = await input.cliApi.run({
    binaryPath: input.binaryPath,
    args: ["conversation", "show", "--md", input.conversationId],
    allowNonZeroExit: true,
    timeoutMs: 4_000,
  });
  if (result.code !== 0) {
    return undefined;
  }
  return normalizeForgeConversationShowText(result.stdout);
}

export async function deleteForgeConversation(input: {
  readonly binaryPath: string;
  readonly conversationId: string;
  readonly cliApi: ForgeCliApi;
}): Promise<void> {
  await input.cliApi.run({
    binaryPath: input.binaryPath,
    args: ["conversation", "delete", input.conversationId],
    allowNonZeroExit: true,
  });
}

function normalizeForgeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function titleForForgeItemType(itemType: ToolLifecycleItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function forgeToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = normalizeForgeToolName(toolName);
  if (normalized.length === 0) {
    return "dynamic_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized === "sage" ||
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent") ||
    normalized.includes("agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized === "read" ||
    normalized === "fs_search" ||
    normalized.includes("read file") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  ) {
    return "dynamic_tool_call";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete") ||
    normalized.includes("rename")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

export function forgeToolLifecycleTitle(toolName: string): string {
  const normalized = normalizeForgeToolName(toolName);
  if (normalized === "read" || normalized.includes("read file")) {
    return "Read file";
  }
  if (
    normalized === "fs_search" ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  ) {
    return normalized.includes("web") ? "Web search" : "Search files";
  }
  if (
    normalized === "sage" ||
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent") ||
    normalized.includes("agent")
  ) {
    return "Subagent task";
  }
  return titleForForgeItemType(forgeToolLifecycleItemType(toolName));
}

export function toForgeThreadTokenUsageSnapshot(
  usage: NonNullable<ForgeParsedConversationDump["turns"][number]["usage"]>,
): ThreadTokenUsageSnapshot {
  return {
    usedTokens: usage.usedTokens,
    totalProcessedTokens: usage.usedTokens,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    lastUsedTokens: usage.usedTokens,
    ...(usage.inputTokens !== undefined ? { lastInputTokens: usage.inputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined
      ? { lastCachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.outputTokens !== undefined ? { lastOutputTokens: usage.outputTokens } : {}),
  };
}
