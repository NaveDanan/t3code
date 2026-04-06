import { randomBytes } from "node:crypto";

import type {
  AssistantMessage,
  Event as OpencodeEvent,
  FileDiff,
  FilePartInput,
  Message,
  Part,
  QuestionAnswer,
  QuestionRequest,
  Session as OpencodeSdkSession,
  TextPartInput,
} from "@opencode-ai/sdk/v2";
import {
  EventId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadTokenUsageSnapshot,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, Exit, FileSystem, Fiber, Layer, Queue, Scope, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OpencodeAdapter, type OpencodeAdapterShape } from "../Services/OpencodeAdapter.ts";
import {
  OpencodeServerManager,
  type OpencodeServerEvent,
} from "../Services/OpencodeServerManager.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { resolveOpencodeModel } from "../opencode.ts";

const PROVIDER = "opencode" as const;

interface OpencodeResumeCursor {
  readonly sessionId?: string;
  readonly cwd?: string;
}

interface OpencodeTurnState {
  readonly turnId: TurnId;
  userMessageId?: string;
  assistantMessageId?: string;
  started: boolean;
  completed: boolean;
  hasCurrentTurnActivity: boolean;
  readonly planMode: boolean;
  readonly planTextParts: Array<string>;
  readonly requestedModelSlug?: string;
  aggregatedUsage: ThreadTokenUsageSnapshot | undefined;
  accumulatedTotalCostUsd: number | undefined;
  latestStopReason: string | null | undefined;
  latestErrorMessage: string | undefined;
}

interface OpencodeSessionContext {
  session: ProviderSession;
  readonly providerSessionId: string;
  readonly binaryPath: string;
  cwd: string;
  activeTurn: OpencodeTurnState | undefined;
  readonly acceptedFollowupTurns: Array<OpencodeTurnState>;
  pendingAbortTurnId: TurnId | undefined;
  readonly pendingRequests: Map<string, CanonicalRequestType>;
  readonly pendingUserInputs: Map<string, ReadonlyArray<UserInputQuestion>>;
  readonly messageInfoById: Map<
    string,
    {
      readonly role: Message["role"];
      readonly parentMessageId?: string;
    }
  >;
  readonly partsById: Map<string, Part>;
  readonly startedItemIds: Set<string>;
  readonly completedItemIds: Set<string>;
  readonly partsWithDelta: Set<string>;
  lastTodoFingerprint: string | undefined;
  stopped: boolean;
}

export interface OpencodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function resetTurnTracking(context: OpencodeSessionContext) {
  context.partsById.clear();
  context.startedItemIds.clear();
  context.completedItemIds.clear();
  context.partsWithDelta.clear();
  context.lastTodoFingerprint = undefined;
}

function removeAcceptedFollowupTurn(context: OpencodeSessionContext, turnId: TurnId) {
  const index = context.acceptedFollowupTurns.findIndex((entry) => entry.turnId === turnId);
  if (index === -1) {
    return undefined;
  }
  const [turn] = context.acceptedFollowupTurns.splice(index, 1);
  return turn;
}

function opencodeDebugContext(context: OpencodeSessionContext | undefined) {
  const activeTurn = context?.activeTurn;
  return {
    threadId: context ? String(context.session.threadId) : undefined,
    providerSessionId: context?.providerSessionId,
    sessionStatus: context?.session.status,
    activeTurnId: activeTurn ? String(activeTurn.turnId) : undefined,
    activeTurnCompleted: activeTurn?.completed,
    activeTurnHasActivity: activeTurn?.hasCurrentTurnActivity,
    userMessageId: activeTurn?.userMessageId,
    assistantMessageId: activeTurn?.assistantMessageId,
    acceptedFollowupTurnIds: context?.acceptedFollowupTurns.map((turn) => String(turn.turnId)),
    acceptedFollowupTurnCount: context?.acceptedFollowupTurns.length,
    pendingAbortTurnId: context?.pendingAbortTurnId
      ? String(context.pendingAbortTurnId)
      : undefined,
    pendingRequests: context?.pendingRequests.size,
    pendingUserInputs: context?.pendingUserInputs.size,
    startedItems: context?.startedItemIds.size,
    completedItems: context?.completedItemIds.size,
    partsWithDelta: context?.partsWithDelta.size,
  };
}

function logOpencodeAdapter(step: string, details?: Record<string, unknown> | undefined): void {
  if (details) {
    console.log(`[opencode][adapter] ${step}`, details);
    return;
  }
  console.log(`[opencode][adapter] ${step}`);
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause.trim();
  }
  if (cause && typeof cause === "object") {
    try {
      const serialized = JSON.stringify(cause);
      if (serialized.length > 0 && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Fall through to the fallback string.
    }
  }
  return fallback;
}

const OPENCODE_IDENTIFIER_RANDOM_LENGTH = 14;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastOpencodeMessageIdTimestamp = 0;
let lastOpencodeMessageIdCounter = 0;

function randomBase62(length: number): string {
  let result = "";
  const bytes = randomBytes(length);

  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) {
      continue;
    }
    result += BASE62_CHARS[byte % 62];
  }

  return result;
}

function createOpencodeMessageId(): string {
  // OpenCode compares message IDs lexicographically when deciding whether a
  // resumed session needs a fresh assistant reply, so follow-up prompts must
  // use the provider's ascending `msg_` identifier shape instead of UUIDs.
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastOpencodeMessageIdTimestamp) {
    lastOpencodeMessageIdTimestamp = currentTimestamp;
    lastOpencodeMessageIdCounter = 0;
  }

  lastOpencodeMessageIdCounter += 1;
  const encodedTimestamp =
    BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(lastOpencodeMessageIdCounter);
  const timeBytes = Buffer.alloc(6);

  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((encodedTimestamp >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }

  return `msg_${timeBytes.toString("hex")}${randomBase62(OPENCODE_IDENTIFIER_RANDOM_LENGTH)}`;
}

function turnIdFromOpencodeMessageId(messageId: string): TurnId {
  return TurnId.makeUnsafe(`opencode-turn:${messageId}`);
}

function toIsoDateFromMillis(
  value: number | undefined,
  fallback = new Date().toISOString(),
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sumOptionalNumbers(...values: ReadonlyArray<number | undefined>): number | undefined {
  const numbers = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );

  if (numbers.length === 0) {
    return undefined;
  }

  return numbers.reduce((total, value) => total + value, 0);
}

function maxOptionalNumber(...values: ReadonlyArray<number | undefined>): number | undefined {
  const numbers = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );

  if (numbers.length === 0) {
    return undefined;
  }

  return Math.max(...numbers);
}

function mergeThreadTokenUsageSnapshots(
  current: ThreadTokenUsageSnapshot | undefined,
  next: ThreadTokenUsageSnapshot | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!current) {
    return next;
  }

  if (!next) {
    return current;
  }

  const totalProcessedTokens = sumOptionalNumbers(
    current.totalProcessedTokens ?? current.usedTokens,
    next.totalProcessedTokens ?? next.usedTokens,
  );
  const maxTokens = maxOptionalNumber(current.maxTokens, next.maxTokens);
  const inputTokens = sumOptionalNumbers(current.inputTokens, next.inputTokens);
  const cachedInputTokens = sumOptionalNumbers(current.cachedInputTokens, next.cachedInputTokens);
  const outputTokens = sumOptionalNumbers(current.outputTokens, next.outputTokens);
  const reasoningOutputTokens = sumOptionalNumbers(
    current.reasoningOutputTokens,
    next.reasoningOutputTokens,
  );
  const toolUses = sumOptionalNumbers(current.toolUses, next.toolUses);
  const durationMs = sumOptionalNumbers(current.durationMs, next.durationMs);

  return {
    usedTokens: current.usedTokens + next.usedTokens,
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(next.lastUsedTokens !== undefined
      ? { lastUsedTokens: next.lastUsedTokens }
      : next.usedTokens !== undefined
        ? { lastUsedTokens: next.usedTokens }
        : {}),
    ...(next.lastInputTokens !== undefined
      ? { lastInputTokens: next.lastInputTokens }
      : next.inputTokens !== undefined
        ? { lastInputTokens: next.inputTokens }
        : {}),
    ...(next.lastCachedInputTokens !== undefined
      ? { lastCachedInputTokens: next.lastCachedInputTokens }
      : next.cachedInputTokens !== undefined
        ? { lastCachedInputTokens: next.cachedInputTokens }
        : {}),
    ...(next.lastOutputTokens !== undefined
      ? { lastOutputTokens: next.lastOutputTokens }
      : next.outputTokens !== undefined
        ? { lastOutputTokens: next.outputTokens }
        : {}),
    ...(next.lastReasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: next.lastReasoningOutputTokens }
      : next.reasoningOutputTokens !== undefined
        ? { lastReasoningOutputTokens: next.reasoningOutputTokens }
        : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(current.compactsAutomatically === true || next.compactsAutomatically === true
      ? { compactsAutomatically: true }
      : {}),
  };
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function asRuntimeRequestId(value: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function asProviderItemId(value: string): ProviderItemId {
  return ProviderItemId.makeUnsafe(value);
}

function readResumeCursor(resumeCursor: unknown): OpencodeResumeCursor | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }

  const record = resumeCursor as Record<string, unknown>;
  const sessionId =
    typeof record.sessionId === "string"
      ? record.sessionId
      : typeof record.sessionID === "string"
        ? record.sessionID
        : undefined;
  const cwd = typeof record.cwd === "string" ? record.cwd : undefined;

  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function readSdkResponseData<T>(result: unknown, operation: string): T {
  const requestResult = result as {
    data?: T;
    error?: unknown;
    response?: Response;
  };

  if (requestResult.data !== undefined) {
    return requestResult.data;
  }

  if (requestResult.error instanceof Error) {
    throw requestResult.error;
  }

  if (requestResult.error !== undefined) {
    throw new Error(
      `${operation} failed: ${typeof requestResult.error === "string" ? requestResult.error : JSON.stringify(requestResult.error)}`,
    );
  }

  const status = requestResult.response?.status;
  if (status !== undefined && status >= 200 && status < 300) {
    return undefined as T;
  }
  throw new Error(
    status ? `${operation} failed with HTTP ${status}.` : `${operation} returned no data.`,
  );
}

function readSdkData<T>(request: Promise<unknown>, operation: string): Promise<T> {
  return request.then((result) => readSdkResponseData<T>(result, operation));
}

function toValidationError(operation: string, issue: string): ProviderAdapterValidationError {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue,
  });
}

function toRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed.`),
    cause,
  });
}

function toProcessError(
  threadId: ThreadId,
  detail: string,
  cause?: unknown,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function canonicalRequestTypeFromPermission(permission: string | undefined): CanonicalRequestType {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "edit":
      return "file_change_approval";
    case "read":
    case "list":
    case "glob":
    case "grep":
    case "lsp":
    case "codesearch":
      return "file_read_approval";
    default:
      return "unknown";
  }
}

function classifyToolItemType(toolName: string | undefined): CanonicalItemType {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("diff")
  ) {
    return "file_change";
  }
  if (normalized.includes("search") || normalized.includes("grep")) {
    return "web_search";
  }
  if (normalized.includes("agent") || normalized.includes("task")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function streamKindFromToolItemType(itemType: CanonicalItemType) {
  switch (itemType) {
    case "command_execution":
      return "command_output" as const;
    case "file_change":
      return "file_change_output" as const;
    default:
      return "unknown" as const;
  }
}

function usageFromAssistantMessage(
  message: AssistantMessage,
): ThreadTokenUsageSnapshot | undefined {
  const cacheRead = message.tokens.cache.read;
  const cacheWrite = message.tokens.cache.write;
  const inputTokens = message.tokens.input;
  const outputTokens = message.tokens.output;
  const reasoningOutputTokens = message.tokens.reasoning;
  const derivedUsedTokens =
    inputTokens + outputTokens + reasoningOutputTokens + cacheRead + cacheWrite;
  const usedTokens = message.tokens.total ?? derivedUsedTokens;
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    inputTokens,
    cachedInputTokens: cacheRead,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cacheRead,
    lastOutputTokens: outputTokens,
    lastReasoningOutputTokens: reasoningOutputTokens,
  };
}

function readSessionId(event: OpencodeEvent): string | undefined {
  const properties = event.properties as { sessionID?: unknown };
  return typeof properties.sessionID === "string" ? properties.sessionID : undefined;
}

function toQuestions(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  const questions: Array<UserInputQuestion> = [];

  for (const [index, question] of request.questions.entries()) {
    const id = `${request.id}:${index}`;
    const header = trimString(question.header);
    const prompt = trimString(question.question);
    if (!header || !prompt) {
      continue;
    }

    const options = question.options.flatMap((option) => {
      const label = trimString(option.label);
      const description = trimString(option.description) ?? label;
      if (!label || !description) {
        return [];
      }
      return [{ label, description }];
    });
    if (options.length === 0) {
      continue;
    }

    questions.push({
      id,
      header,
      question: prompt,
      options,
      multiSelect: question.multiple === true,
    });
  }

  return questions;
}

function answersFromReplyEvent(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ReadonlyArray<QuestionAnswer>,
): ProviderUserInputAnswers {
  return Object.fromEntries(
    questions.map((question, index) => {
      const selections =
        answers[index]?.filter((entry): entry is string => typeof entry === "string") ?? [];
      if (selections.length === 0) {
        return [question.id, ""] as const;
      }
      return [question.id, selections.length === 1 ? selections[0] : selections] as const;
    }),
  );
}

function answersToQuestionReply(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Array<QuestionAnswer> {
  return questions.map((question) => {
    const value = answers[question.id];
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized.length > 0 ? [normalized] : [];
    }
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        if (typeof entry !== "string") {
          return [];
        }
        const normalized = entry.trim();
        return normalized.length > 0 ? [normalized] : [];
      });
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nestedAnswers = (value as { answers?: unknown }).answers;
      if (Array.isArray(nestedAnswers)) {
        return nestedAnswers.flatMap((entry) => {
          if (typeof entry !== "string") {
            return [];
          }
          const normalized = entry.trim();
          return normalized.length > 0 ? [normalized] : [];
        });
      }
    }
    return [];
  });
}

function renderUnifiedDiff(diffs: ReadonlyArray<FileDiff>): string {
  const sections: Array<string> = [];
  for (const diff of diffs) {
    sections.push(`diff --git a/${diff.file} b/${diff.file}`);
    sections.push(`--- a/${diff.file}`);
    sections.push(`+++ b/${diff.file}`);
    sections.push("@@");
    if (diff.before.length > 0) {
      sections.push(...diff.before.split(/\r?\n/).map((line) => `-${line}`));
    }
    if (diff.after.length > 0) {
      sections.push(...diff.after.split(/\r?\n/).map((line) => `+${line}`));
    }
  }
  return sections.join("\n");
}

function messagesToThreadSnapshot(
  threadId: ThreadId,
  messages: ReadonlyArray<{ info: Message; parts: Array<Part> }>,
) {
  const ordered = messages.toSorted(
    (left, right) => left.info.time.created - right.info.time.created,
  );
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  const turnsByUserMessageId = new Map<string, { id: TurnId; items: Array<unknown> }>();

  for (const entry of ordered) {
    if (entry.info.role === "user") {
      const turn = {
        id: turnIdFromOpencodeMessageId(entry.info.id),
        items: [entry],
      };
      turns.push(turn);
      turnsByUserMessageId.set(entry.info.id, turn);
      continue;
    }

    const assistantMessage = entry.info as AssistantMessage;
    const parentTurn = turnsByUserMessageId.get(assistantMessage.parentID);
    if (parentTurn) {
      parentTurn.items.push(entry);
      continue;
    }

    turns.push({
      id: turnIdFromOpencodeMessageId(assistantMessage.parentID || assistantMessage.id),
      items: [entry],
    });
  }

  return {
    threadId,
    turns,
  };
}

function rawEvent(event: OpencodeEvent) {
  return {
    source: "opencode.sdk.event" as const,
    messageType: event.type,
    payload: event.properties,
  };
}

function bindAssistantMessageId(
  context: OpencodeSessionContext,
  messageId: string | undefined,
): string | undefined {
  if (!context.activeTurn || context.activeTurn.completed || !messageId) {
    return undefined;
  }

  if (messageId === context.activeTurn.userMessageId) {
    return undefined;
  }

  const knownMessage = context.messageInfoById.get(messageId);
  if (knownMessage?.role === "user") {
    return undefined;
  }

  if (
    knownMessage?.role === "assistant" &&
    knownMessage.parentMessageId !== undefined &&
    context.activeTurn.userMessageId !== undefined &&
    knownMessage.parentMessageId !== context.activeTurn.userMessageId
  ) {
    return undefined;
  }

  if (
    context.activeTurn.assistantMessageId !== undefined &&
    context.activeTurn.assistantMessageId !== messageId &&
    !context.completedItemIds.has(context.activeTurn.assistantMessageId)
  ) {
    return undefined;
  }

  context.activeTurn.assistantMessageId = messageId;
  context.messageInfoById.set(messageId, {
    role: "assistant",
    ...(knownMessage?.parentMessageId !== undefined
      ? { parentMessageId: knownMessage.parentMessageId }
      : {}),
  });
  return messageId;
}

function rememberAssistantCompletion(
  activeTurn: OpencodeTurnState,
  input: {
    readonly usage?: ThreadTokenUsageSnapshot;
    readonly totalCostUsd?: number;
    readonly stopReason?: string | null;
    readonly errorMessage?: string;
  },
): void {
  activeTurn.hasCurrentTurnActivity = true;
  activeTurn.aggregatedUsage = mergeThreadTokenUsageSnapshots(
    activeTurn.aggregatedUsage,
    input.usage,
  );
  if (input.totalCostUsd !== undefined) {
    activeTurn.accumulatedTotalCostUsd =
      (activeTurn.accumulatedTotalCostUsd ?? 0) + input.totalCostUsd;
  }
  if (input.stopReason !== undefined) {
    activeTurn.latestStopReason = input.stopReason;
  }
  activeTurn.latestErrorMessage = input.errorMessage;
}

function markCurrentTurnActivity(context: OpencodeSessionContext): void {
  if (!context.activeTurn || context.activeTurn.completed) {
    return;
  }

  context.activeTurn.hasCurrentTurnActivity = true;
  logOpencodeAdapter("turn.activity.marked", opencodeDebugContext(context));
}

function latestUserMessageIdFromMessages(
  messages: ReadonlyArray<{ info: Message; parts: Array<Part> }>,
): string | undefined {
  const latestUserMessage = messages
    .filter((entry) => entry.info.role === "user")
    .toSorted((left, right) => right.info.time.created - left.info.time.created)
    .at(0);

  return latestUserMessage?.info.id;
}

function replyFromDecision(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "acceptForSession":
      return "always";
    case "accept":
      return "once";
    case "cancel":
    case "decline":
    default:
      return "reject";
  }
}

const makeOpencodeAdapter = Effect.fn("makeOpencodeAdapter")(function* (
  options?: OpencodeAdapterLiveOptions,
) {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettingsService = yield* ServerSettingsService;
  const opencodeServerManager = yield* OpencodeServerManager;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const ownsNativeEventLogger = options?.nativeEventLogger === undefined;

  const sessions = new Map<ThreadId, OpencodeSessionContext>();
  const sessionIdsToThreadIds = new Map<string, ThreadId>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const eventSubscriptionScope = yield* Scope.make("sequential");
  let eventSubscriptionFiber: Fiber.Fiber<void, never> | undefined = undefined;
  let subscribedBinaryPath: string | undefined = undefined;

  const makeEventStamp = () => ({
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    createdAt: nowIso(),
  });

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (
    event: OpencodeServerEvent,
    threadId: ThreadId | null,
  ) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, threadId);
  });

  const offerRuntimeEvent = Effect.fn("offerRuntimeEvent")(function* (event: ProviderRuntimeEvent) {
    yield* Queue.offer(runtimeEventQueue, event);
  });

  const resolveOpencodeSettings = Effect.fn("resolveOpencodeSettings")(function* () {
    return yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.opencode),
    );
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    if (context.stopped || context.session.status === "closed") {
      return yield* new ProviderAdapterSessionClosedError({
        provider: PROVIDER,
        threadId,
      });
    }
    return context;
  });

  const updateSession = (context: OpencodeSessionContext, next: Partial<ProviderSession>) => {
    context.session = {
      ...context.session,
      ...next,
      updatedAt: nowIso(),
    };
  };

  const emitSessionStateChanged = Effect.fn("emitSessionStateChanged")(function* (
    context: OpencodeSessionContext,
    state: "starting" | "ready" | "running" | "waiting" | "stopped" | "error",
    reason?: string,
  ) {
    const stamp = makeEventStamp();
    yield* offerRuntimeEvent({
      type: "session.state.changed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: stamp.createdAt,
      payload: {
        state,
        ...(reason ? { reason } : {}),
      },
    });
  });

  const emitTurnStarted = Effect.fn("emitTurnStarted")(function* (
    context: OpencodeSessionContext,
    turn: OpencodeTurnState,
    raw?: OpencodeEvent,
  ) {
    if (turn.started) {
      return;
    }

    turn.started = true;
    const stamp = makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: stamp.eventId,
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: stamp.createdAt,
      turnId: turn.turnId,
      providerRefs: {
        providerTurnId: String(turn.turnId),
      },
      ...(raw ? { raw: rawEvent(raw) } : {}),
      payload: turn.requestedModelSlug ? { model: turn.requestedModelSlug } : {},
    });
  });

  const activateTurn = Effect.fn("activateTurn")(function* (
    context: OpencodeSessionContext,
    turn: OpencodeTurnState,
    raw?: OpencodeEvent,
  ) {
    resetTurnTracking(context);
    context.activeTurn = turn;
    updateSession(context, {
      status: "running",
      activeTurnId: turn.turnId,
      ...(turn.requestedModelSlug ? { model: turn.requestedModelSlug } : {}),
      ...(context.session.lastError ? { lastError: undefined } : {}),
    });
    yield* emitTurnStarted(context, turn, raw);
    yield* emitSessionStateChanged(context, "running");
    return turn;
  });

  const promoteAcceptedFollowupTurn = Effect.fn("promoteAcceptedFollowupTurn")(function* (
    context: OpencodeSessionContext,
    input: {
      readonly raw?: OpencodeEvent;
      readonly parentMessageId?: string;
      readonly fallbackToOldest?: boolean;
    },
  ) {
    if (context.activeTurn && !context.activeTurn.completed) {
      return context.activeTurn;
    }

    if (context.acceptedFollowupTurns.length === 0) {
      return undefined;
    }

    let nextTurn: OpencodeTurnState | undefined;
    const parentMessageId = trimString(input.parentMessageId);
    if (parentMessageId) {
      const directMatchIndex = context.acceptedFollowupTurns.findIndex(
        (entry) => entry.userMessageId === parentMessageId,
      );
      if (directMatchIndex !== -1) {
        [nextTurn] = context.acceptedFollowupTurns.splice(directMatchIndex, 1);
      } else {
        const latestUserMessageId = yield* fetchMessages(context).pipe(
          Effect.map(latestUserMessageIdFromMessages),
          Effect.catch(() => Effect.void),
        );
        if (latestUserMessageId === parentMessageId) {
          nextTurn = context.acceptedFollowupTurns.shift();
        }
      }
    } else if (input.fallbackToOldest) {
      nextTurn = context.acceptedFollowupTurns.shift();
    }

    if (!nextTurn) {
      return undefined;
    }

    if (parentMessageId) {
      nextTurn.userMessageId = parentMessageId;
    }

    return yield* activateTurn(context, nextTurn, input.raw);
  });

  const ensureAssistantItemStarted = Effect.fn("ensureAssistantItemStarted")(function* (
    context: OpencodeSessionContext,
    assistantMessageId: string,
    raw?: OpencodeEvent,
  ) {
    if (context.startedItemIds.has(assistantMessageId)) {
      return;
    }

    context.startedItemIds.add(assistantMessageId);
    const stamp = makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.started",
      eventId: stamp.eventId,
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: stamp.createdAt,
      ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
      itemId: asRuntimeItemId(assistantMessageId),
      providerRefs: {
        ...(context.activeTurn ? { providerTurnId: String(context.activeTurn.turnId) } : {}),
        providerItemId: asProviderItemId(assistantMessageId),
      },
      ...(raw ? { raw: rawEvent(raw) } : {}),
      payload: {
        itemType: "assistant_message",
        title: "Assistant message",
        status: "inProgress",
      },
    });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: OpencodeSessionContext,
    input: {
      readonly state: "completed" | "failed" | "cancelled" | "interrupted";
      readonly stopReason?: string | null;
      readonly usage?: ThreadTokenUsageSnapshot;
      readonly totalCostUsd?: number;
      readonly errorMessage?: string;
      readonly raw?: OpencodeEvent;
    },
  ) {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) {
      logOpencodeAdapter("turn.complete.skipped", {
        reason: "no-active-turn",
        ...opencodeDebugContext(context),
      });
      return;
    }

    logOpencodeAdapter("turn.complete.begin", {
      state: input.state,
      stopReason: input.stopReason,
      errorMessage: input.errorMessage,
      ...opencodeDebugContext(context),
    });
    activeTurn.completed = true;
    const hasAcceptedFollowups = context.acceptedFollowupTurns.length > 0;
    const nextState = hasAcceptedFollowups
      ? "running"
      : input.state === "failed"
        ? "error"
        : "ready";
    updateSession(context, {
      status: nextState,
      activeTurnId: undefined,
      ...(input.errorMessage ? { lastError: input.errorMessage } : {}),
    });
    if (input.usage) {
      const usageStamp = makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: usageStamp.eventId,
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: usageStamp.createdAt,
        turnId: activeTurn.turnId,
        providerRefs: {
          providerTurnId: String(activeTurn.turnId),
        },
        ...(input.raw ? { raw: rawEvent(input.raw) } : {}),
        payload: {
          usage: input.usage,
        },
      });
    }

    if (activeTurn.planMode && input.state === "completed") {
      const planMarkdown = activeTurn.planTextParts.join("");
      if (planMarkdown.trim().length > 0) {
        const proposedStamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          eventId: proposedStamp.eventId,
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: proposedStamp.createdAt,
          turnId: activeTurn.turnId,
          providerRefs: {
            providerTurnId: String(activeTurn.turnId),
          },
          ...(input.raw ? { raw: rawEvent(input.raw) } : {}),
          payload: {
            planMarkdown,
          },
        });
      }
    }

    const completionStamp = makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: completionStamp.eventId,
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: completionStamp.createdAt,
      turnId: activeTurn.turnId,
      providerRefs: {
        providerTurnId: String(activeTurn.turnId),
      },
      ...(input.raw ? { raw: rawEvent(input.raw) } : {}),
      payload: {
        state: input.state,
        ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      },
    });
    yield* emitSessionStateChanged(
      context,
      nextState,
      nextState === "error" ? input.errorMessage : undefined,
    );
    context.activeTurn = undefined;
    context.pendingAbortTurnId = undefined;
    logOpencodeAdapter("turn.complete.end", {
      nextState,
      ...opencodeDebugContext(context),
    });
  });

  const abortTurn = Effect.fn("abortTurn")(function* (
    context: OpencodeSessionContext,
    reason: string,
    raw?: OpencodeEvent,
  ) {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) {
      logOpencodeAdapter("turn.abort.skipped", {
        reason: "no-active-turn",
        ...opencodeDebugContext(context),
      });
      return;
    }

    logOpencodeAdapter("turn.abort.begin", {
      reason,
      ...opencodeDebugContext(context),
    });
    activeTurn.completed = true;
    const nextState = context.acceptedFollowupTurns.length > 0 ? "running" : "ready";
    updateSession(context, {
      status: nextState,
      activeTurnId: undefined,
    });
    const stamp = makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.aborted",
      eventId: stamp.eventId,
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: stamp.createdAt,
      turnId: activeTurn.turnId,
      providerRefs: {
        providerTurnId: String(activeTurn.turnId),
      },
      ...(raw ? { raw: rawEvent(raw) } : {}),
      payload: {
        reason,
      },
    });
    yield* emitSessionStateChanged(context, nextState);
    context.activeTurn = undefined;
    context.pendingAbortTurnId = undefined;
    logOpencodeAdapter("turn.abort.end", opencodeDebugContext(context));
  });

  const abortAcceptedFollowupTurn = Effect.fn("abortAcceptedFollowupTurn")(function* (
    context: OpencodeSessionContext,
    turnId: TurnId,
    reason: string,
    raw?: OpencodeEvent,
  ) {
    const turn = removeAcceptedFollowupTurn(context, turnId);
    if (!turn) {
      return;
    }

    turn.completed = true;
    updateSession(context, {
      status: context.acceptedFollowupTurns.length > 0 ? "running" : "ready",
      activeTurnId: undefined,
    });
    const stamp = makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.aborted",
      eventId: stamp.eventId,
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: stamp.createdAt,
      turnId: turn.turnId,
      providerRefs: {
        providerTurnId: String(turn.turnId),
      },
      ...(raw ? { raw: rawEvent(raw) } : {}),
      payload: {
        reason,
      },
    });
    yield* emitSessionStateChanged(
      context,
      context.acceptedFollowupTurns.length > 0 ? "running" : "ready",
    );
    context.pendingAbortTurnId = undefined;
  });

  const buildAttachmentPart = Effect.fn("buildAttachmentPart")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* toRequestError(
        "session.promptAsync",
        new Error(`Invalid attachment id '${attachment.id}'.`),
      );
    }

    const bytes = yield* fileSystem
      .readFile(attachmentPath)
      .pipe(Effect.mapError((cause) => toRequestError("session.promptAsync", cause)));

    return {
      type: "file" as const,
      mime: attachment.mimeType,
      filename: attachment.name,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    } satisfies FilePartInput;
  });

  const fetchMessages = Effect.fn("fetchMessages")(function* (context: OpencodeSessionContext) {
    const server = yield* opencodeServerManager
      .ensureServer({
        binaryPath: context.binaryPath,
      })
      .pipe(
        Effect.mapError((error) => toProcessError(context.session.threadId, error.message, error)),
      );

    return yield* Effect.tryPromise({
      try: () =>
        readSdkData<Array<{ info: Message; parts: Array<Part> }>>(
          server.client.session.messages({
            sessionID: context.providerSessionId,
            directory: context.cwd,
            limit: 1_000,
          }),
          "session.messages",
        ),
      catch: (cause) => toRequestError("session.messages", cause),
    });
  });

  const resolveAssistantParentMessageId = Effect.fn("resolveAssistantParentMessageId")(function* (
    context: OpencodeSessionContext,
    turn: OpencodeTurnState,
    parentMessageId: string | undefined,
  ) {
    if (!parentMessageId) {
      logOpencodeAdapter("assistant.parent.resolve.skipped", {
        parentMessageId,
        reason: "missing-parent-message-id",
        ...opencodeDebugContext(context),
      });
      return undefined;
    }

    if (turn.userMessageId === parentMessageId) {
      logOpencodeAdapter("assistant.parent.resolve.direct-hit", {
        parentMessageId,
        ...opencodeDebugContext(context),
      });
      return parentMessageId;
    }

    const latestUserMessageId = yield* fetchMessages(context).pipe(
      Effect.map(latestUserMessageIdFromMessages),
      Effect.catch(() => Effect.void),
    );

    logOpencodeAdapter("assistant.parent.resolve.result", {
      parentMessageId,
      latestUserMessageId,
      matched: latestUserMessageId === parentMessageId,
      ...opencodeDebugContext(context),
    });

    return latestUserMessageId === parentMessageId ? parentMessageId : undefined;
  });

  const stopEventSubscription = Effect.fn("stopEventSubscription")(function* () {
    if (eventSubscriptionFiber) {
      yield* Fiber.interrupt(eventSubscriptionFiber);
      eventSubscriptionFiber = undefined;
    }
    subscribedBinaryPath = undefined;
    yield* opencodeServerManager.stop;
  });

  const handleServerEvent = Effect.fn("handleServerEvent")(function* (
    serverEvent: OpencodeServerEvent,
  ) {
    const sessionId = readSessionId(serverEvent.payload);
    const threadId = sessionId ? (sessionIdsToThreadIds.get(sessionId) ?? null) : null;
    yield* writeNativeEvent(serverEvent, threadId);
    logOpencodeAdapter("event.received", {
      eventType: serverEvent.payload.type,
      sessionId,
      threadId: threadId ? String(threadId) : undefined,
    });

    if (!sessionId || !threadId) {
      logOpencodeAdapter("event.ignored.unroutable", {
        eventType: serverEvent.payload.type,
        sessionId,
        threadId: threadId ? String(threadId) : undefined,
      });
      return;
    }
    const context = sessions.get(threadId);
    if (!context || context.stopped) {
      logOpencodeAdapter("event.ignored.missing-context", {
        eventType: serverEvent.payload.type,
        stopped: context?.stopped,
        ...opencodeDebugContext(context),
      });
      return;
    }

    switch (serverEvent.payload.type) {
      case "session.created":
      case "session.updated": {
        logOpencodeAdapter("event.session.updated", {
          eventType: serverEvent.payload.type,
          directory: serverEvent.payload.properties.info.directory,
          title: trimString(serverEvent.payload.properties.info.title),
          ...opencodeDebugContext(context),
        });
        context.cwd = serverEvent.payload.properties.info.directory;
        const title = trimString(serverEvent.payload.properties.info.title);
        if (title) {
          const stamp = makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.metadata.updated",
            eventId: stamp.eventId,
            provider: PROVIDER,
            threadId,
            createdAt: stamp.createdAt,
            payload: {
              name: title,
            },
            raw: rawEvent(serverEvent.payload),
          });
        }
        return;
      }

      case "session.deleted": {
        logOpencodeAdapter("event.session.deleted", opencodeDebugContext(context));
        updateSession(context, { status: "closed", activeTurnId: undefined });
        yield* emitSessionStateChanged(context, "stopped");
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.exited",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          payload: {
            exitKind: "graceful",
            recoverable: true,
            reason: "session deleted",
          },
          raw: rawEvent(serverEvent.payload),
        });
        context.stopped = true;
        sessions.delete(threadId);
        sessionIdsToThreadIds.delete(context.providerSessionId);
        if (sessions.size === 0) {
          yield* stopEventSubscription();
        }
        return;
      }

      case "session.status": {
        logOpencodeAdapter("event.session.status", {
          statusType: serverEvent.payload.properties.status.type,
          ...opencodeDebugContext(context),
        });
        if (serverEvent.payload.properties.status.type === "busy") {
          if (
            (context.activeTurn && !context.activeTurn.completed) ||
            context.acceptedFollowupTurns.length > 0
          ) {
            updateSession(context, { status: "running" });
            yield* emitSessionStateChanged(context, "running");
          }
        }
        if (serverEvent.payload.properties.status.type === "retry") {
          const stamp = makeEventStamp();
          yield* offerRuntimeEvent({
            type: "runtime.warning",
            eventId: stamp.eventId,
            provider: PROVIDER,
            threadId,
            createdAt: stamp.createdAt,
            ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
            raw: rawEvent(serverEvent.payload),
            payload: {
              message: serverEvent.payload.properties.status.message,
              detail: {
                attempt: serverEvent.payload.properties.status.attempt,
                next: serverEvent.payload.properties.status.next,
              },
            },
          });
        }
        return;
      }

      case "session.idle": {
        logOpencodeAdapter("event.session.idle", opencodeDebugContext(context));
        if (context.pendingAbortTurnId) {
          logOpencodeAdapter("event.session.idle.abort-pending", opencodeDebugContext(context));
          if (context.activeTurn && !context.activeTurn.completed) {
            yield* abortTurn(context, "OpenCode runtime interrupted.", serverEvent.payload);
          } else {
            yield* abortAcceptedFollowupTurn(
              context,
              context.pendingAbortTurnId,
              "OpenCode runtime interrupted.",
              serverEvent.payload,
            );
          }
        } else if (context.activeTurn && !context.activeTurn.completed) {
          if (!context.activeTurn.hasCurrentTurnActivity) {
            logOpencodeAdapter("event.session.idle.ignored.no-current-turn-activity", {
              ...opencodeDebugContext(context),
            });
            return;
          }

          logOpencodeAdapter("event.session.idle.complete-turn", opencodeDebugContext(context));
          yield* completeTurn(context, {
            state: context.activeTurn.latestErrorMessage ? "failed" : "completed",
            ...(context.activeTurn.latestStopReason !== undefined
              ? { stopReason: context.activeTurn.latestStopReason }
              : {}),
            ...(context.activeTurn.aggregatedUsage
              ? { usage: context.activeTurn.aggregatedUsage }
              : {}),
            ...(context.activeTurn.accumulatedTotalCostUsd !== undefined
              ? { totalCostUsd: context.activeTurn.accumulatedTotalCostUsd }
              : {}),
            ...(context.activeTurn.latestErrorMessage
              ? { errorMessage: context.activeTurn.latestErrorMessage }
              : {}),
            raw: serverEvent.payload,
          });
        } else if (context.session.status === "running") {
          if (context.acceptedFollowupTurns.length > 0) {
            logOpencodeAdapter("event.session.idle.ignored.accepted-followup-pending", {
              ...opencodeDebugContext(context),
            });
            return;
          }
          logOpencodeAdapter("event.session.idle.reset-ready-without-active-turn", {
            ...opencodeDebugContext(context),
          });
          updateSession(context, {
            status: "ready",
            activeTurnId: undefined,
          });
          yield* emitSessionStateChanged(context, "ready");
        }
        return;
      }

      case "session.compacted": {
        logOpencodeAdapter("event.session.compacted", opencodeDebugContext(context));
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.state.changed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          payload: {
            state: "compacted",
          },
          raw: rawEvent(serverEvent.payload),
        });
        return;
      }

      case "session.diff": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        if (!context.activeTurn) {
          logOpencodeAdapter(
            "event.session.diff.ignored.no-active-turn",
            opencodeDebugContext(context),
          );
          return;
        }
        markCurrentTurnActivity(context);
        const unifiedDiff = renderUnifiedDiff(serverEvent.payload.properties.diff);
        if (unifiedDiff.length === 0) {
          return;
        }
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.diff.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          turnId: context.activeTurn.turnId,
          providerRefs: {
            providerTurnId: String(context.activeTurn.turnId),
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            unifiedDiff,
          },
        });
        return;
      }

      case "session.error": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        logOpencodeAdapter("event.session.error", {
          ...opencodeDebugContext(context),
          errorMessage:
            trimString(serverEvent.payload.properties.error?.data?.message) ??
            "OpenCode runtime error.",
        });
        markCurrentTurnActivity(context);
        const errorMessage =
          trimString(serverEvent.payload.properties.error?.data?.message) ??
          "OpenCode runtime error.";
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          raw: rawEvent(serverEvent.payload),
          payload: {
            message: errorMessage,
            class: "provider_error",
            detail: serverEvent.payload.properties.error,
          },
        });
        if (context.pendingAbortTurnId) {
          yield* abortTurn(context, errorMessage, serverEvent.payload);
        } else {
          yield* completeTurn(context, {
            state: "failed",
            errorMessage,
            raw: serverEvent.payload,
          });
        }
        return;
      }

      case "permission.asked": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        const turnId = context.activeTurn?.turnId;
        logOpencodeAdapter("event.permission.asked", {
          requestId: serverEvent.payload.properties.id,
          permission: serverEvent.payload.properties.permission,
          ...opencodeDebugContext(context),
        });
        markCurrentTurnActivity(context);
        const requestType = canonicalRequestTypeFromPermission(
          serverEvent.payload.properties.permission,
        );
        context.pendingRequests.set(serverEvent.payload.properties.id, requestType);
        const detail = trimString(
          typeof serverEvent.payload.properties.metadata?.message === "string"
            ? serverEvent.payload.properties.metadata.message
            : undefined,
        );
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(turnId ? { turnId } : {}),
          requestId: asRuntimeRequestId(serverEvent.payload.properties.id),
          providerRefs: {
            ...(turnId ? { providerTurnId: String(turnId) } : {}),
            providerRequestId: serverEvent.payload.properties.id,
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            requestType,
            ...(detail ? { detail } : {}),
            args: {
              permission: serverEvent.payload.properties.permission,
              patterns: serverEvent.payload.properties.patterns,
              metadata: serverEvent.payload.properties.metadata,
            },
          },
        });
        return;
      }

      case "permission.replied": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        logOpencodeAdapter("event.permission.replied", {
          requestId: serverEvent.payload.properties.requestID,
          reply: serverEvent.payload.properties.reply,
          ...opencodeDebugContext(context),
        });
        markCurrentTurnActivity(context);
        const pendingType =
          context.pendingRequests.get(serverEvent.payload.properties.requestID) ?? "unknown";
        context.pendingRequests.delete(serverEvent.payload.properties.requestID);
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.resolved",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          requestId: asRuntimeRequestId(serverEvent.payload.properties.requestID),
          providerRefs: {
            ...(context.activeTurn ? { providerTurnId: String(context.activeTurn.turnId) } : {}),
            providerRequestId: serverEvent.payload.properties.requestID,
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            requestType: pendingType,
            decision: serverEvent.payload.properties.reply,
          },
        });
        return;
      }

      case "question.asked": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        logOpencodeAdapter("event.question.asked", {
          requestId: serverEvent.payload.properties.id,
          questionCount: serverEvent.payload.properties.questions.length,
          ...opencodeDebugContext(context),
        });
        markCurrentTurnActivity(context);
        const questions = toQuestions(serverEvent.payload.properties);
        context.pendingUserInputs.set(serverEvent.payload.properties.id, questions);
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          requestId: asRuntimeRequestId(serverEvent.payload.properties.id),
          providerRefs: {
            ...(context.activeTurn ? { providerTurnId: String(context.activeTurn.turnId) } : {}),
            providerRequestId: serverEvent.payload.properties.id,
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            questions,
          },
        });
        return;
      }

      case "question.replied": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        logOpencodeAdapter("event.question.replied", {
          requestId: serverEvent.payload.properties.requestID,
          ...opencodeDebugContext(context),
        });
        markCurrentTurnActivity(context);
        const questions =
          context.pendingUserInputs.get(serverEvent.payload.properties.requestID) ?? [];
        context.pendingUserInputs.delete(serverEvent.payload.properties.requestID);
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          requestId: asRuntimeRequestId(serverEvent.payload.properties.requestID),
          providerRefs: {
            ...(context.activeTurn ? { providerTurnId: String(context.activeTurn.turnId) } : {}),
            providerRequestId: serverEvent.payload.properties.requestID,
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            answers: answersFromReplyEvent(questions, serverEvent.payload.properties.answers),
          },
        });
        return;
      }

      case "question.rejected": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        logOpencodeAdapter("event.question.rejected", {
          requestId: serverEvent.payload.properties.requestID,
          ...opencodeDebugContext(context),
        });
        markCurrentTurnActivity(context);
        context.pendingUserInputs.delete(serverEvent.payload.properties.requestID);
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          requestId: asRuntimeRequestId(serverEvent.payload.properties.requestID),
          providerRefs: {
            ...(context.activeTurn ? { providerTurnId: String(context.activeTurn.turnId) } : {}),
            providerRequestId: serverEvent.payload.properties.requestID,
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            answers: {},
          },
        });
        return;
      }

      case "todo.updated": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            fallbackToOldest: true,
          });
        }
        if (!context.activeTurn) {
          logOpencodeAdapter(
            "event.todo.updated.ignored.no-active-turn",
            opencodeDebugContext(context),
          );
          return;
        }
        logOpencodeAdapter("event.todo.updated", {
          todoCount: serverEvent.payload.properties.todos.length,
          ...opencodeDebugContext(context),
        });
        markCurrentTurnActivity(context);
        const plan = serverEvent.payload.properties.todos.map((todo) => ({
          step: todo.content,
          status:
            todo.status === "completed" || todo.status === "cancelled"
              ? "completed"
              : todo.status === "in_progress"
                ? "inProgress"
                : "pending",
        })) as Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
        const fingerprint = JSON.stringify(plan);
        if (fingerprint === context.lastTodoFingerprint) {
          return;
        }
        context.lastTodoFingerprint = fingerprint;
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.plan.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          turnId: context.activeTurn.turnId,
          providerRefs: {
            providerTurnId: String(context.activeTurn.turnId),
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            plan,
          },
        });
        return;
      }

      case "message.updated": {
        logOpencodeAdapter("event.message.updated", {
          role: serverEvent.payload.properties.info.role,
          messageId: serverEvent.payload.properties.info.id,
          ...opencodeDebugContext(context),
        });
        const messageParentId =
          serverEvent.payload.properties.info.role === "assistant"
            ? trimString((serverEvent.payload.properties.info as AssistantMessage).parentID)
            : undefined;
        context.messageInfoById.set(serverEvent.payload.properties.info.id, {
          role: serverEvent.payload.properties.info.role,
          ...(messageParentId ? { parentMessageId: messageParentId } : {}),
        });

        if (serverEvent.payload.properties.info.role === "user") {
          const userMessageId = serverEvent.payload.properties.info.id;
          // OpenCode broadcasts message.updated for ALL messages in the session
          // history when processing a new prompt. Only update the active turn's
          // user message ID if it matches what sendTurn registered. Mismatched IDs
          // are from previous turns and must be ignored to prevent overwriting the
          // current turn state and triggering premature completeTurn calls.
          if (!context.activeTurn || context.activeTurn.completed) {
            if (
              context.acceptedFollowupTurns.some((entry) => entry.userMessageId === userMessageId)
            ) {
              logOpencodeAdapter("event.message.updated.user.accepted-followup-buffered", {
                messageId: userMessageId,
                ...opencodeDebugContext(context),
              });
              return;
            }
            logOpencodeAdapter("event.message.updated.user.ignored.no-active-turn", {
              messageId: userMessageId,
              ...opencodeDebugContext(context),
            });
            return;
          }
          if (
            context.activeTurn.userMessageId !== undefined &&
            context.activeTurn.userMessageId !== userMessageId
          ) {
            logOpencodeAdapter("event.message.updated.user.ignored.mismatched-user-message", {
              messageId: userMessageId,
              expectedUserMessageId: context.activeTurn.userMessageId,
              ...opencodeDebugContext(context),
            });
            return;
          }
          context.activeTurn.userMessageId = userMessageId;
          logOpencodeAdapter("event.message.updated.user.accepted", {
            messageId: userMessageId,
            countsAsCurrentTurnActivity: false,
            ...opencodeDebugContext(context),
          });
          return;
        }

        // Assistant message: only process events that belong to the current active
        // turn. OpenCode replays completed assistant messages from prior turns as
        // history; accepting them would overwrite turn.userMessageId and trigger
        // completeTurn on the live turn, corrupting the turn lifecycle.
        const assistantMessage = serverEvent.payload.properties.info as AssistantMessage;
        const parentMessageId = trimString(assistantMessage.parentID);
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            ...(parentMessageId ? { parentMessageId } : {}),
          });
        }
        if (!context.activeTurn || context.activeTurn.completed) {
          logOpencodeAdapter("event.message.updated.assistant.ignored.no-active-turn", {
            messageId: serverEvent.payload.properties.info.id,
            ...opencodeDebugContext(context),
          });
          return;
        }
        const reboundUserMessageId =
          parentMessageId !== undefined &&
          context.activeTurn.userMessageId !== parentMessageId &&
          (context.activeTurn.assistantMessageId === undefined ||
            context.activeTurn.assistantMessageId === assistantMessage.id)
            ? yield* resolveAssistantParentMessageId(context, context.activeTurn, parentMessageId)
            : undefined;
        const belongsToCurrentTurn =
          !parentMessageId ||
          context.activeTurn.userMessageId === undefined ||
          context.activeTurn.userMessageId === parentMessageId ||
          context.activeTurn.assistantMessageId === assistantMessage.id ||
          reboundUserMessageId !== undefined;
        if (!belongsToCurrentTurn) {
          logOpencodeAdapter("event.message.updated.assistant.ignored.not-current-turn", {
            messageId: assistantMessage.id,
            parentMessageId,
            reboundUserMessageId,
            ...opencodeDebugContext(context),
          });
          return;
        }
        if (
          parentMessageId &&
          (context.activeTurn.userMessageId === undefined || reboundUserMessageId !== undefined)
        ) {
          context.activeTurn.userMessageId = reboundUserMessageId ?? parentMessageId;
        }
        context.activeTurn.assistantMessageId = assistantMessage.id;
        context.messageInfoById.set(assistantMessage.id, {
          role: "assistant",
          ...(parentMessageId ? { parentMessageId } : {}),
        });
        markCurrentTurnActivity(context);
        logOpencodeAdapter("event.message.updated.assistant.accepted", {
          messageId: assistantMessage.id,
          parentMessageId,
          reboundUserMessageId,
          completedAt: assistantMessage.time.completed,
          hasError: assistantMessage.error !== undefined,
          ...opencodeDebugContext(context),
        });
        const activeTurnId = context.activeTurn.turnId;

        yield* ensureAssistantItemStarted(context, assistantMessage.id, serverEvent.payload);

        if (assistantMessage.time.completed || assistantMessage.error) {
          const errorMessage = trimString(assistantMessage.error?.data?.message);
          const usage = usageFromAssistantMessage(assistantMessage);
          if (!context.completedItemIds.has(assistantMessage.id)) {
            rememberAssistantCompletion(context.activeTurn, {
              ...(usage ? { usage } : {}),
              ...(assistantMessage.cost !== undefined
                ? { totalCostUsd: assistantMessage.cost }
                : {}),
              stopReason: assistantMessage.finish ?? null,
              ...(errorMessage ? { errorMessage } : {}),
            });
            context.completedItemIds.add(assistantMessage.id);
            const itemStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.completed",
              eventId: itemStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: itemStamp.createdAt,
              turnId: activeTurnId,
              itemId: asRuntimeItemId(assistantMessage.id),
              providerRefs: {
                providerTurnId: String(activeTurnId),
                providerItemId: asProviderItemId(assistantMessage.id),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                itemType: "assistant_message",
                status: errorMessage ? "failed" : "completed",
                title: "Assistant message",
                ...(errorMessage ? { detail: errorMessage } : {}),
              },
            });
          }
        }
        return;
      }

      case "message.part.delta": {
        if (
          (!context.activeTurn || context.activeTurn.completed) &&
          context.acceptedFollowupTurns.length > 0
        ) {
          const messageId = trimString(serverEvent.payload.properties.messageID);
          const parentMessageId = messageId
            ? context.messageInfoById.get(messageId)?.parentMessageId
            : undefined;
          yield* promoteAcceptedFollowupTurn(context, {
            raw: serverEvent.payload,
            ...(parentMessageId ? { parentMessageId } : {}),
            fallbackToOldest: true,
          });
        }
        const assistantMessageId = bindAssistantMessageId(
          context,
          trimString(serverEvent.payload.properties.messageID),
        );
        if (!assistantMessageId) {
          logOpencodeAdapter("event.message.part.delta.ignored.unbound", {
            messageId: trimString(serverEvent.payload.properties.messageID),
            partId: serverEvent.payload.properties.partID,
            deltaLength: serverEvent.payload.properties.delta.length,
            ...opencodeDebugContext(context),
          });
          return;
        }
        markCurrentTurnActivity(context);
        const partId = serverEvent.payload.properties.partID;
        const cachedPart = partId ? context.partsById.get(partId) : undefined;
        if (cachedPart?.type !== "reasoning" && cachedPart?.type !== "tool") {
          yield* ensureAssistantItemStarted(context, assistantMessageId, serverEvent.payload);
        }
        if (partId) {
          context.partsWithDelta.add(partId);
        }
        const streamKind =
          cachedPart?.type === "reasoning"
            ? "reasoning_text"
            : cachedPart?.type === "tool"
              ? streamKindFromToolItemType(classifyToolItemType(cachedPart.tool))
              : "assistant_text";
        const itemId =
          cachedPart?.type === "reasoning" || cachedPart?.type === "tool"
            ? partId
            : assistantMessageId;
        logOpencodeAdapter("event.message.part.delta.accepted", {
          resolvedAssistantMessageId: assistantMessageId,
          partId,
          cachedPartType: cachedPart?.type,
          itemId,
          deltaLength: serverEvent.payload.properties.delta.length,
          ...opencodeDebugContext(context),
        });
        const stamp = makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          threadId,
          createdAt: stamp.createdAt,
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          itemId: asRuntimeItemId(itemId),
          providerRefs: {
            ...(context.activeTurn ? { providerTurnId: String(context.activeTurn.turnId) } : {}),
            providerItemId: asProviderItemId(itemId),
          },
          raw: rawEvent(serverEvent.payload),
          payload: {
            streamKind,
            delta: serverEvent.payload.properties.delta,
          },
        });

        if (
          streamKind === "assistant_text" &&
          context.activeTurn?.planMode &&
          serverEvent.payload.properties.delta.length > 0
        ) {
          context.activeTurn.planTextParts.push(serverEvent.payload.properties.delta);
          const proposedStamp = makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.proposed.delta",
            eventId: proposedStamp.eventId,
            provider: PROVIDER,
            threadId,
            createdAt: proposedStamp.createdAt,
            turnId: context.activeTurn.turnId,
            providerRefs: {
              providerTurnId: String(context.activeTurn.turnId),
            },
            raw: rawEvent(serverEvent.payload),
            payload: {
              delta: serverEvent.payload.properties.delta,
            },
          });
        }
        return;
      }

      case "message.part.updated": {
        const part = serverEvent.payload.properties.part;
        context.partsById.set(part.id, part);
        logOpencodeAdapter("event.message.part.updated", {
          partId: part.id,
          partType: part.type,
          messageId: "messageID" in part ? part.messageID : undefined,
          ...opencodeDebugContext(context),
        });
        if (part.type === "reasoning") {
          if (
            (!context.activeTurn || context.activeTurn.completed) &&
            context.acceptedFollowupTurns.length > 0
          ) {
            yield* promoteAcceptedFollowupTurn(context, {
              raw: serverEvent.payload,
              fallbackToOldest: true,
            });
          }
          markCurrentTurnActivity(context);
          if (!context.startedItemIds.has(part.id)) {
            context.startedItemIds.add(part.id);
            const itemStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.started",
              eventId: itemStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: itemStamp.createdAt,
              ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
              itemId: asRuntimeItemId(part.id),
              providerRefs: {
                ...(context.activeTurn
                  ? { providerTurnId: String(context.activeTurn.turnId) }
                  : {}),
                providerItemId: asProviderItemId(part.id),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                itemType: "reasoning",
                title: "Reasoning",
                status: "inProgress",
              },
            });
          }

          if (!context.partsWithDelta.has(part.id) && part.text.length > 0) {
            const deltaStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: deltaStamp.createdAt,
              ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
              itemId: asRuntimeItemId(part.id),
              providerRefs: {
                ...(context.activeTurn
                  ? { providerTurnId: String(context.activeTurn.turnId) }
                  : {}),
                providerItemId: asProviderItemId(part.id),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                streamKind: "reasoning_text",
                delta: part.text,
              },
            });
          }

          if (part.time.end && !context.completedItemIds.has(part.id)) {
            context.completedItemIds.add(part.id);
            const completedStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.completed",
              eventId: completedStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: completedStamp.createdAt,
              ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
              itemId: asRuntimeItemId(part.id),
              providerRefs: {
                ...(context.activeTurn
                  ? { providerTurnId: String(context.activeTurn.turnId) }
                  : {}),
                providerItemId: asProviderItemId(part.id),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                itemType: "reasoning",
                title: "Reasoning",
                status: "completed",
              },
            });
          }
          return;
        }

        if (part.type === "text") {
          if (
            (!context.activeTurn || context.activeTurn.completed) &&
            context.acceptedFollowupTurns.length > 0
          ) {
            const partMessageId = trimString(part.messageID);
            const parentMessageId = partMessageId
              ? context.messageInfoById.get(partMessageId)?.parentMessageId
              : undefined;
            yield* promoteAcceptedFollowupTurn(context, {
              raw: serverEvent.payload,
              ...(parentMessageId ? { parentMessageId } : {}),
              fallbackToOldest: true,
            });
          }
          const assistantMessageId = bindAssistantMessageId(context, trimString(part.messageID));
          if (!assistantMessageId) {
            logOpencodeAdapter("event.message.part.updated.text.ignored.unbound", {
              partId: part.id,
              messageId: trimString(part.messageID),
              ...opencodeDebugContext(context),
            });
            return;
          }

          markCurrentTurnActivity(context);
          logOpencodeAdapter("event.message.part.updated.text.accepted", {
            partId: part.id,
            resolvedAssistantMessageId: assistantMessageId,
            textLength: part.text.length,
            ...opencodeDebugContext(context),
          });
          yield* ensureAssistantItemStarted(context, assistantMessageId, serverEvent.payload);
          if (!context.partsWithDelta.has(part.id) && part.text.length > 0) {
            const deltaStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: deltaStamp.createdAt,
              ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
              itemId: asRuntimeItemId(assistantMessageId),
              providerRefs: {
                ...(context.activeTurn
                  ? { providerTurnId: String(context.activeTurn.turnId) }
                  : {}),
                providerItemId: asProviderItemId(assistantMessageId),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                streamKind: "assistant_text",
                delta: part.text,
              },
            });

            if (context.activeTurn?.planMode) {
              context.activeTurn.planTextParts.push(part.text);
              const proposedStamp = makeEventStamp();
              yield* offerRuntimeEvent({
                type: "turn.proposed.delta",
                eventId: proposedStamp.eventId,
                provider: PROVIDER,
                threadId,
                createdAt: proposedStamp.createdAt,
                turnId: context.activeTurn.turnId,
                providerRefs: {
                  providerTurnId: String(context.activeTurn.turnId),
                },
                raw: rawEvent(serverEvent.payload),
                payload: {
                  delta: part.text,
                },
              });
            }
          }
          return;
        }

        if (part.type === "tool") {
          if (
            (!context.activeTurn || context.activeTurn.completed) &&
            context.acceptedFollowupTurns.length > 0
          ) {
            yield* promoteAcceptedFollowupTurn(context, {
              raw: serverEvent.payload,
              fallbackToOldest: true,
            });
          }
          markCurrentTurnActivity(context);
          logOpencodeAdapter("event.message.part.updated.tool.accepted", {
            partId: part.id,
            tool: part.tool,
            toolState: part.state.status,
            ...opencodeDebugContext(context),
          });
          const itemType = classifyToolItemType(part.tool);
          const itemId = part.id;
          if (!context.startedItemIds.has(itemId)) {
            context.startedItemIds.add(itemId);
            const startedStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.started",
              eventId: startedStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: startedStamp.createdAt,
              ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
              itemId: asRuntimeItemId(itemId),
              providerRefs: {
                ...(context.activeTurn
                  ? { providerTurnId: String(context.activeTurn.turnId) }
                  : {}),
                providerItemId: asProviderItemId(itemId),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                itemType,
                title: part.tool,
                status: "inProgress",
                data: part,
              },
            });
          }

          const output =
            part.state.status === "completed"
              ? part.state.output
              : part.state.status === "error"
                ? part.state.error
                : undefined;
          if (
            typeof output === "string" &&
            output.length > 0 &&
            !context.partsWithDelta.has(itemId)
          ) {
            const progressStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: progressStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: progressStamp.createdAt,
              ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
              itemId: asRuntimeItemId(itemId),
              providerRefs: {
                ...(context.activeTurn
                  ? { providerTurnId: String(context.activeTurn.turnId) }
                  : {}),
                providerItemId: asProviderItemId(itemId),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                streamKind: streamKindFromToolItemType(itemType),
                delta: output,
              },
            });
          }

          if (
            (part.state.status === "completed" || part.state.status === "error") &&
            !context.completedItemIds.has(itemId)
          ) {
            context.completedItemIds.add(itemId);
            const completedStamp = makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.completed",
              eventId: completedStamp.eventId,
              provider: PROVIDER,
              threadId,
              createdAt: completedStamp.createdAt,
              ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
              itemId: asRuntimeItemId(itemId),
              providerRefs: {
                ...(context.activeTurn
                  ? { providerTurnId: String(context.activeTurn.turnId) }
                  : {}),
                providerItemId: asProviderItemId(itemId),
              },
              raw: rawEvent(serverEvent.payload),
              payload: {
                itemType,
                title: part.tool,
                status: part.state.status === "completed" ? "completed" : "failed",
                ...(output ? { detail: output } : {}),
                data: part,
              },
            });
          }
        }
        return;
      }

      default:
        return;
    }
  });

  const ensureEventSubscription = Effect.fn("ensureEventSubscription")(function* (
    binaryPath: string,
  ) {
    if (eventSubscriptionFiber && subscribedBinaryPath === binaryPath) {
      return;
    }

    if (eventSubscriptionFiber) {
      yield* Fiber.interrupt(eventSubscriptionFiber);
      eventSubscriptionFiber = undefined;
    }

    subscribedBinaryPath = binaryPath;
    eventSubscriptionFiber = yield* Stream.runForEach(
      opencodeServerManager.streamEvents({ binaryPath }),
      (event) =>
        handleServerEvent(event).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Effect.logWarning("OpenCode adapter failed to process runtime event", {
                cause: String(cause),
              }),
            onSuccess: () => Effect.void,
          }),
        ),
    ).pipe(Effect.forkIn(eventSubscriptionScope));
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: OpencodeSessionContext,
    options: {
      readonly emitExitEvent: boolean;
    },
  ) {
    logOpencodeAdapter("session.stop.begin", {
      emitExitEvent: options.emitExitEvent,
      ...opencodeDebugContext(context),
    });
    if (context.stopped) {
      logOpencodeAdapter("session.stop.skipped.already-stopped", {
        emitExitEvent: options.emitExitEvent,
        ...opencodeDebugContext(context),
      });
      return;
    }

    const server =
      context.activeTurn || context.acceptedFollowupTurns.length > 0
        ? yield* opencodeServerManager
            .ensureServer({
              binaryPath: context.binaryPath,
            })
            .pipe(
              Effect.mapError((error) =>
                toProcessError(context.session.threadId, error.message, error),
              ),
              Effect.matchEffect({
                onFailure: () => Effect.void.pipe(Effect.as(undefined)),
                onSuccess: (server) => Effect.succeed(server),
              }),
            )
        : undefined;

    if (server && (context.activeTurn || context.acceptedFollowupTurns.length > 0)) {
      yield* Effect.tryPromise({
        try: () =>
          readSdkData<boolean>(
            server.client.session.abort({
              sessionID: context.providerSessionId,
              directory: context.cwd,
            }),
            "session.abort",
          ),
        catch: () => undefined,
      }).pipe(
        Effect.matchEffect({
          onFailure: () => Effect.void,
          onSuccess: () => Effect.void,
        }),
      );
    }

    context.stopped = true;
    updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });

    if (options.emitExitEvent) {
      yield* emitSessionStateChanged(context, "stopped");
      const stamp = makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: stamp.createdAt,
        payload: {
          exitKind: "graceful",
          recoverable: true,
        },
      });
    }

    sessions.delete(context.session.threadId);
    sessionIdsToThreadIds.delete(context.providerSessionId);
    if (sessions.size === 0) {
      yield* stopEventSubscription();
    }
    logOpencodeAdapter("session.stop.end", {
      emitExitEvent: options.emitExitEvent,
      threadId: String(context.session.threadId),
      providerSessionId: context.providerSessionId,
    });
  });

  const startSession: OpencodeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      logOpencodeAdapter("startSession.begin", {
        threadId: String(input.threadId),
        provider: input.provider,
        cwd: input.cwd,
        runtimeMode: input.runtimeMode,
        hasResumeCursor: input.resumeCursor !== undefined,
      });
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* toValidationError(
          "startSession",
          `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        );
      }

      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        logOpencodeAdapter("startSession.reuse-existing", opencodeDebugContext(existing));
        return existing.session;
      }

      const opencodeSettings = yield* resolveOpencodeSettings().pipe(
        Effect.mapError((error) => toRequestError("startSession", error)),
      );
      const binaryPath = opencodeSettings.binaryPath;
      const server = yield* opencodeServerManager
        .ensureServer({
          binaryPath,
        })
        .pipe(Effect.mapError((error) => toProcessError(input.threadId, error.message, error)));

      const resumeCursor = readResumeCursor(input.resumeCursor);
      const resumeSessionId = resumeCursor?.sessionId;
      let sdkSession: OpencodeSdkSession;
      if (resumeSessionId) {
        logOpencodeAdapter("startSession.resume", {
          threadId: String(input.threadId),
          resumeSessionId,
          resumeCwd: resumeCursor?.cwd,
        });
        sdkSession = yield* Effect.tryPromise({
          try: () =>
            readSdkData<OpencodeSdkSession>(
              server.client.session.get({
                sessionID: resumeSessionId,
                ...(resumeCursor.cwd ? { directory: resumeCursor.cwd } : {}),
              }),
              "session.get",
            ),
          catch: (cause) =>
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
              cause,
            }),
        });
      } else {
        const cwd = trimString(input.cwd);
        if (!cwd) {
          return yield* toValidationError(
            "startSession",
            "OpenCode sessions require a cwd or a resume cursor.",
          );
        }
        logOpencodeAdapter("startSession.create", {
          threadId: String(input.threadId),
          cwd,
        });
        sdkSession = yield* Effect.tryPromise({
          try: () =>
            readSdkData<OpencodeSdkSession>(
              server.client.session.create({
                directory: cwd,
              }),
              "session.create",
            ),
          catch: (cause) =>
            toProcessError(
              input.threadId,
              toMessage(cause, "Failed to create OpenCode session."),
              cause,
            ),
        });
      }

      const selectedModel =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: sdkSession.directory,
        ...(selectedModel ? { model: selectedModel } : {}),
        threadId: input.threadId,
        resumeCursor: {
          sessionId: sdkSession.id,
          cwd: sdkSession.directory,
        },
        createdAt: toIsoDateFromMillis(sdkSession.time.created),
        updatedAt: toIsoDateFromMillis(sdkSession.time.updated),
      };

      const context: OpencodeSessionContext = {
        session,
        providerSessionId: sdkSession.id,
        binaryPath,
        cwd: sdkSession.directory,
        activeTurn: undefined,
        acceptedFollowupTurns: [],
        pendingAbortTurnId: undefined,
        pendingRequests: new Map(),
        pendingUserInputs: new Map(),
        messageInfoById: new Map(),
        partsById: new Map(),
        startedItemIds: new Set(),
        completedItemIds: new Set(),
        partsWithDelta: new Set(),
        lastTodoFingerprint: undefined,
        stopped: false,
      };

      sessions.set(input.threadId, context);
      sessionIdsToThreadIds.set(sdkSession.id, input.threadId);
      yield* ensureEventSubscription(binaryPath);
      logOpencodeAdapter("startSession.ready", {
        ...opencodeDebugContext(context),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });

      const startedStamp = makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: startedStamp.eventId,
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: startedStamp.createdAt,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
      });
      const threadStartedStamp = makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: threadStartedStamp.eventId,
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: threadStartedStamp.createdAt,
        payload: {
          providerThreadId: sdkSession.id,
        },
      });
      const configuredStamp = makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        threadId: input.threadId,
        createdAt: configuredStamp.createdAt,
        payload: {
          config: {
            providerSessionId: sdkSession.id,
            cwd: sdkSession.directory,
          },
        },
      });
      yield* emitSessionStateChanged(context, "ready");

      return session;
    },
  );

  const sendTurn: OpencodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    logOpencodeAdapter("sendTurn.begin", {
      threadId: String(input.threadId),
      inputLength: input.input?.length ?? 0,
      attachmentCount: input.attachments?.length ?? 0,
      interactionMode: input.interactionMode,
      modelSelection:
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined,
    });
    if (input.modelSelection !== undefined && input.modelSelection.provider !== PROVIDER) {
      return yield* toValidationError(
        "sendTurn",
        `Expected model selection provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
      );
    }

    const context = yield* requireSession(input.threadId);
    const providerIsBusy =
      (context.activeTurn !== undefined && !context.activeTurn.completed) ||
      context.acceptedFollowupTurns.length > 0 ||
      context.session.status === "running";

    const server = yield* opencodeServerManager
      .ensureServer({
        binaryPath: context.binaryPath,
      })
      .pipe(Effect.mapError((error) => toProcessError(input.threadId, error.message, error)));

    const promptParts: Array<TextPartInput | FilePartInput> = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => buildAttachmentPart(input, attachment),
      { concurrency: 1 },
    );
    if (input.input) {
      promptParts.unshift({
        type: "text",
        text: input.input,
      });
    }
    if (promptParts.length === 0) {
      return yield* toValidationError(
        "sendTurn",
        "OpenCode turns require text input or attachments.",
      );
    }
    logOpencodeAdapter("sendTurn.prompt-parts-ready", {
      totalPartCount: promptParts.length,
      hasTextInput: input.input !== undefined && input.input.length > 0,
      ...opencodeDebugContext(context),
    });

    const resolvedModelSlug =
      input.modelSelection?.provider === PROVIDER
        ? input.modelSelection.model
        : context.session.model;
    const selectedVariant =
      input.modelSelection?.provider === PROVIDER
        ? input.modelSelection.options?.effort
        : undefined;
    const model =
      resolvedModelSlug !== undefined
        ? yield* opencodeServerManager
            .probe({
              binaryPath: context.binaryPath,
            })
            .pipe(
              Effect.mapError((error) => toProcessError(input.threadId, error.message, error)),
              Effect.flatMap((probe) => {
                const resolvedModel = resolveOpencodeModel(resolvedModelSlug, probe);
                if (!resolvedModel) {
                  return Effect.fail(
                    toValidationError(
                      "sendTurn",
                      `Could not resolve OpenCode model '${resolvedModelSlug}' against the active provider catalog.`,
                    ),
                  );
                }
                return Effect.succeed(resolvedModel);
              }),
            )
        : undefined;

    const turnId = TurnId.makeUnsafe(crypto.randomUUID());
    const providerUserMessageId = createOpencodeMessageId();
    const turnState: OpencodeTurnState = {
      turnId,
      userMessageId: providerUserMessageId,
      started: false,
      completed: false,
      hasCurrentTurnActivity: false,
      planMode: input.interactionMode === "plan",
      planTextParts: [],
      ...(resolvedModelSlug ? { requestedModelSlug: resolvedModelSlug } : {}),
      aggregatedUsage: undefined,
      accumulatedTotalCostUsd: undefined,
      latestStopReason: undefined,
      latestErrorMessage: undefined,
    };
    logOpencodeAdapter(
      providerIsBusy ? "sendTurn.followup-accepted" : "sendTurn.active-turn-created",
      {
        turnId: String(turnId),
        providerUserMessageId,
        resolvedModelSlug,
        selectedVariant,
        ...opencodeDebugContext(context),
      },
    );
    if (providerIsBusy) {
      context.acceptedFollowupTurns.push(turnState);
    } else {
      yield* activateTurn(context, turnState);
    }
    logOpencodeAdapter("sendTurn.promptAsync.dispatch", {
      turnId: String(turnId),
      providerUserMessageId,
      resolvedModelSlug,
      selectedVariant,
      ...opencodeDebugContext(context),
    });

    const promptResult = yield* Effect.tryPromise({
      try: () =>
        readSdkData<void>(
          server.client.session.promptAsync({
            sessionID: context.providerSessionId,
            directory: context.cwd,
            messageID: providerUserMessageId,
            ...(model ? { model } : {}),
            ...(input.interactionMode === "plan" ? { agent: "plan" } : {}),
            ...(selectedVariant ? { variant: selectedVariant } : {}),
            parts: promptParts,
          }),
          "session.promptAsync",
        ),
      catch: (cause) => toRequestError("session.promptAsync", cause),
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.sync(() =>
            logOpencodeAdapter("sendTurn.promptAsync.failed", {
              turnId: String(turnId),
              errorMessage: error.message,
              ...opencodeDebugContext(context),
            }),
          ).pipe(
            Effect.andThen(
              context.activeTurn?.turnId === turnId
                ? completeTurn(context, {
                    state: "failed",
                    errorMessage: error.message,
                  })
                : Effect.sync(() => {
                    removeAcceptedFollowupTurn(context, turnId);
                  }),
            ),
            Effect.andThen(Effect.fail(error)),
          ),
        onSuccess: (result) =>
          Effect.sync(() =>
            logOpencodeAdapter("sendTurn.promptAsync.accepted", {
              turnId: String(turnId),
              providerUserMessageId,
              ...opencodeDebugContext(context),
            }),
          ).pipe(Effect.andThen(Effect.succeed(result))),
      }),
    );

    void promptResult;

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: OpencodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, turnId) {
      logOpencodeAdapter("interruptTurn.begin", {
        threadId: String(threadId),
        turnId: turnId ? String(turnId) : undefined,
      });
      const context = yield* requireSession(threadId);
      const server = yield* opencodeServerManager
        .ensureServer({
          binaryPath: context.binaryPath,
        })
        .pipe(Effect.mapError((error) => toProcessError(threadId, error.message, error)));

      context.pendingAbortTurnId =
        turnId ?? context.activeTurn?.turnId ?? context.acceptedFollowupTurns[0]?.turnId;
      logOpencodeAdapter("interruptTurn.abort-dispatched", opencodeDebugContext(context));
      yield* Effect.tryPromise({
        try: () =>
          readSdkData<boolean>(
            server.client.session.abort({
              sessionID: context.providerSessionId,
              directory: context.cwd,
            }),
            "session.abort",
          ),
        catch: (cause) => toRequestError("session.abort", cause),
      });
    },
  );

  const readThread: OpencodeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      logOpencodeAdapter("readThread.begin", opencodeDebugContext(context));
      const messages = yield* fetchMessages(context);
      logOpencodeAdapter("readThread.complete", {
        messageCount: messages.length,
        ...opencodeDebugContext(context),
      });
      return messagesToThreadSnapshot(threadId, messages);
    },
  );

  const rollbackThread: OpencodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      logOpencodeAdapter("rollbackThread.begin", {
        threadId: String(threadId),
        numTurns,
      });
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* toValidationError("rollbackThread", "numTurns must be an integer >= 1.");
      }

      const context = yield* requireSession(threadId);
      if (
        (context.activeTurn && !context.activeTurn.completed) ||
        context.acceptedFollowupTurns.length > 0
      ) {
        return yield* toRequestError(
          "session.revert",
          new Error("Cannot rollback an OpenCode thread while a turn is still running."),
        );
      }

      const server = yield* opencodeServerManager
        .ensureServer({
          binaryPath: context.binaryPath,
        })
        .pipe(Effect.mapError((error) => toProcessError(threadId, error.message, error)));

      for (let index = 0; index < numTurns; index += 1) {
        const messages = yield* fetchMessages(context);
        const latestUserMessage = messages
          .toSorted((left, right) => right.info.time.created - left.info.time.created)
          .find((entry) => entry.info.role === "user");
        if (!latestUserMessage) {
          break;
        }
        yield* Effect.tryPromise({
          try: () =>
            readSdkData<OpencodeSdkSession>(
              server.client.session.revert({
                sessionID: context.providerSessionId,
                directory: context.cwd,
                messageID: latestUserMessage.info.id,
              }),
              "session.revert",
            ),
          catch: (cause) => toRequestError("session.revert", cause),
        });
      }

      const messages = yield* fetchMessages(context);
      logOpencodeAdapter("rollbackThread.complete", {
        requestedThreadId: String(threadId),
        remainingMessageCount: messages.length,
        ...opencodeDebugContext(context),
      });
      return messagesToThreadSnapshot(threadId, messages);
    },
  );

  const respondToRequest: OpencodeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      logOpencodeAdapter("respondToRequest.begin", {
        threadId: String(threadId),
        requestId: String(requestId),
        decision,
      });
      const context = yield* requireSession(threadId);
      const pendingRequestId = String(requestId);
      if (!context.pendingRequests.has(pendingRequestId)) {
        return yield* toRequestError(
          "permission.reply",
          new Error(`Unknown pending OpenCode approval request '${pendingRequestId}'.`),
        );
      }

      const server = yield* opencodeServerManager
        .ensureServer({
          binaryPath: context.binaryPath,
        })
        .pipe(Effect.mapError((error) => toProcessError(threadId, error.message, error)));

      yield* Effect.tryPromise({
        try: () =>
          readSdkData<boolean>(
            server.client.permission.reply({
              requestID: pendingRequestId,
              directory: context.cwd,
              reply: replyFromDecision(decision),
            }),
            "permission.reply",
          ),
        catch: (cause) => toRequestError("permission.reply", cause),
      });
      logOpencodeAdapter("respondToRequest.complete", opencodeDebugContext(context));
    },
  );

  const respondToUserInput: OpencodeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    logOpencodeAdapter("respondToUserInput.begin", {
      threadId: String(threadId),
      requestId: String(requestId),
      answerKeys: Object.keys(answers),
    });
    const context = yield* requireSession(threadId);
    const pendingRequestId = String(requestId);
    const questions = context.pendingUserInputs.get(pendingRequestId);
    if (!questions) {
      return yield* toRequestError(
        "question.reply",
        new Error(`Unknown pending OpenCode user-input request '${pendingRequestId}'.`),
      );
    }

    const normalizedAnswers = answersToQuestionReply(questions, answers);
    const server = yield* opencodeServerManager
      .ensureServer({
        binaryPath: context.binaryPath,
      })
      .pipe(Effect.mapError((error) => toProcessError(threadId, error.message, error)));

    if (normalizedAnswers.every((answer) => answer.length === 0)) {
      yield* Effect.tryPromise({
        try: () =>
          readSdkData<boolean>(
            server.client.question.reject({
              requestID: pendingRequestId,
              directory: context.cwd,
            }),
            "question.reject",
          ),
        catch: (cause) => toRequestError("question.reject", cause),
      });
      logOpencodeAdapter("respondToUserInput.rejected-empty", opencodeDebugContext(context));
      return;
    }

    yield* Effect.tryPromise({
      try: () =>
        readSdkData<boolean>(
          server.client.question.reply({
            requestID: pendingRequestId,
            directory: context.cwd,
            answers: normalizedAnswers,
          }),
          "question.reply",
        ),
      catch: (cause) => toRequestError("question.reply", cause),
    });
    logOpencodeAdapter("respondToUserInput.complete", opencodeDebugContext(context));
  });

  const stopSession: OpencodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      logOpencodeAdapter("stopSession.begin", {
        threadId: String(threadId),
      });
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: OpencodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: OpencodeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: OpencodeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(
      Effect.andThen(stopEventSubscription()),
      Effect.andThen(Scope.close(eventSubscriptionScope, Exit.void)),
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(
        ownsNativeEventLogger && nativeEventLogger
          ? nativeEventLogger.close().pipe(Effect.ignore({ log: true }))
          : Effect.void,
      ),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      busyFollowupMode: "native-steer",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies OpencodeAdapterShape;
});

export const OpencodeAdapterLive = Layer.effect(OpencodeAdapter, makeOpencodeAdapter());

export function makeOpencodeAdapterLive(options?: OpencodeAdapterLiveOptions) {
  return Layer.effect(OpencodeAdapter, makeOpencodeAdapter(options));
}
