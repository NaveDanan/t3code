function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractUsageActual(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  return asNumber(asRecord(record?.[key])?.actual);
}

function truncateText(value: string, limit = 240): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export interface ForgeParsedUsage {
  readonly usedTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly totalCostUsd?: number;
  readonly raw: unknown;
}

export interface ForgeParsedToolResult {
  readonly callId: string;
  readonly name: string;
  readonly isError: boolean;
  readonly rawText: string;
  readonly text: string;
}

export interface ForgeParsedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly detail?: string;
  readonly result?: ForgeParsedToolResult;
}

export interface ForgeParsedTurn {
  readonly index: number;
  readonly userText: string;
  readonly assistantTextParts: ReadonlyArray<string>;
  readonly assistantText: string;
  readonly toolCalls: ReadonlyArray<ForgeParsedToolCall>;
  readonly usage?: ForgeParsedUsage;
  readonly rawMessages: ReadonlyArray<unknown>;
}

export interface ForgeParsedConversationDump {
  readonly conversationId: string;
  readonly title?: string;
  readonly turns: ReadonlyArray<ForgeParsedTurn>;
  readonly raw: unknown;
}

export function normalizeForgeToolOutputText(rawText: string): string {
  const withoutCdata = rawText.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const withoutTags = withoutCdata.replace(/<\/?[^>]+>/g, "\n");
  return withoutTags.replace(/\n{3,}/g, "\n\n").trim();
}

export function describeForgeToolCall(toolName: string, args: unknown): string | undefined {
  const record = asRecord(args);
  switch (toolName.trim().toLowerCase()) {
    case "shell":
      return asTrimmedString(record?.command);
    case "read":
      return asTrimmedString(record?.file_path);
    case "fs_search":
      return asTrimmedString(record?.pattern);
    case "sage": {
      const tasks = record?.tasks;
      if (!Array.isArray(tasks)) {
        return undefined;
      }
      const task = tasks
        .map((entry) => asTrimmedString(entry))
        .find((entry) => entry !== undefined);
      return task ? truncateText(task) : undefined;
    }
    default: {
      if (!record) {
        return undefined;
      }
      try {
        return truncateText(JSON.stringify(record));
      } catch {
        return undefined;
      }
    }
  }
}

function parseForgeUsage(value: unknown): ForgeParsedUsage | undefined {
  const record = asRecord(value);
  const usedTokens = extractUsageActual(record, "total_tokens");
  const inputTokens = extractUsageActual(record, "prompt_tokens");
  const cachedInputTokens = extractUsageActual(record, "cached_tokens");
  const outputTokens = extractUsageActual(record, "completion_tokens");
  const totalCostUsd = asNumber(record?.cost);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    raw: value,
  };
}

function parseForgeToolResult(value: unknown): ForgeParsedToolResult | undefined {
  const record = asRecord(value);
  const name = asTrimmedString(record?.name);
  const callId = asTrimmedString(record?.call_id);
  const output = asRecord(record?.output);
  if (!name || !callId || !output) {
    return undefined;
  }

  const rawText = Array.isArray(output.values)
    ? output.values
        .map((entry) => asTrimmedString(asRecord(entry)?.text))
        .filter((entry): entry is string => entry !== undefined)
        .join("\n\n")
    : "";

  return {
    callId,
    name,
    isError: output.is_error === true,
    rawText,
    text: normalizeForgeToolOutputText(rawText),
  };
}

function finalizeTurn(
  turns: Array<ForgeParsedTurn>,
  currentTurn:
    | {
        readonly index: number;
        readonly userText: string;
        readonly assistantTextParts: Array<string>;
        readonly toolCalls: Array<ForgeParsedToolCall>;
        readonly toolResultsById: Map<string, ForgeParsedToolResult>;
        usage?: ForgeParsedUsage;
        readonly rawMessages: Array<unknown>;
      }
    | undefined,
): void {
  if (!currentTurn) {
    return;
  }

  turns.push({
    index: currentTurn.index,
    userText: currentTurn.userText,
    assistantTextParts: [...currentTurn.assistantTextParts],
    assistantText: currentTurn.assistantTextParts.join("\n\n").trim(),
    toolCalls: currentTurn.toolCalls.map((toolCall) => {
      const result = currentTurn.toolResultsById.get(toolCall.callId);
      return {
        ...toolCall,
        ...(result ? { result } : {}),
      };
    }),
    ...(currentTurn.usage ? { usage: currentTurn.usage } : {}),
    rawMessages: [...currentTurn.rawMessages],
  });
}

export function parseForgeConversationDump(raw: string): ForgeParsedConversationDump {
  const parsed = JSON.parse(raw) as unknown;
  const root = asRecord(parsed);
  const conversation = asRecord(root?.conversation);
  const context = asRecord(conversation?.context);
  const conversationId = asTrimmedString(conversation?.id ?? context?.conversation_id);
  if (!conversationId) {
    throw new Error("Forge conversation dump is missing conversation.id.");
  }

  const turns: Array<ForgeParsedTurn> = [];
  let currentTurn:
    | {
        readonly index: number;
        readonly userText: string;
        readonly assistantTextParts: Array<string>;
        readonly toolCalls: Array<ForgeParsedToolCall>;
        readonly toolResultsById: Map<string, ForgeParsedToolResult>;
        usage?: ForgeParsedUsage;
        readonly rawMessages: Array<unknown>;
      }
    | undefined;

  for (const message of Array.isArray(context?.messages) ? context.messages : []) {
    const record = asRecord(message);
    if (!record) {
      continue;
    }

    const textMessage = asRecord(record.text);
    const toolMessage = asRecord(record.tool);
    const role = asTrimmedString(textMessage?.role);

    if (role === "User") {
      finalizeTurn(turns, currentTurn);
      const usage = parseForgeUsage(record.usage);
      currentTurn = {
        index: turns.length + 1,
        userText: textMessage?.content === undefined ? "" : String(textMessage.content),
        assistantTextParts: [],
        toolCalls: [],
        toolResultsById: new Map(),
        ...(usage ? { usage } : {}),
        rawMessages: [message],
      };
      continue;
    }

    if (!currentTurn) {
      continue;
    }

    currentTurn.rawMessages.push(message);

    if (role === "Assistant") {
      const content = textMessage?.content;
      if (typeof content === "string" && content.trim().length > 0) {
        currentTurn.assistantTextParts.push(content);
      }

      if (Array.isArray(textMessage?.tool_calls)) {
        for (const toolCallValue of textMessage.tool_calls) {
          const toolCall = asRecord(toolCallValue);
          const name = asTrimmedString(toolCall?.name);
          const callId = asTrimmedString(toolCall?.call_id);
          const detail = name ? describeForgeToolCall(name, toolCall?.arguments) : undefined;
          if (!name || !callId) {
            continue;
          }
          currentTurn.toolCalls.push({
            callId,
            name,
            args: toolCall?.arguments,
            ...(detail ? { detail } : {}),
          });
        }
      }

      const usage = parseForgeUsage(record.usage);
      if (usage) {
        currentTurn.usage = usage;
      }
      continue;
    }

    if (toolMessage) {
      const result = parseForgeToolResult(toolMessage);
      if (result) {
        currentTurn.toolResultsById.set(result.callId, result);
      }
      continue;
    }
  }

  finalizeTurn(turns, currentTurn);

  const title = asTrimmedString(conversation?.title);
  return {
    conversationId,
    ...(title ? { title } : {}),
    turns,
    raw: parsed,
  };
}
