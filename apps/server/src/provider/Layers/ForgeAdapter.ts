import type { ProcessRunResult } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  EventId,
  RuntimeItemId,
  TurnId,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Result, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { ForgeAdapter, type ForgeAdapterShape } from "../Services/ForgeAdapter.ts";
import {
  buildForgeModelSlug,
  buildForgeAdapterKey,
  createForgeCliApi,
  parseForgeModelCatalogRows,
  parseForgePorcelainTable,
  resolveFallbackForgeModel,
  resolveForgeExecutionTarget,
  resolveForgeModel,
  splitForgeModelSlug,
  toWslPath,
  type ForgeCliApi,
  type ForgeExecutionTarget,
  type ForgeResolvedModel,
  type ForgeSpawnedProcess,
} from "../forgecode.ts";
import { type ForgeParsedTurn } from "../forgecodeDump.ts";
import {
  createForgeConversationId,
  DEFAULT_FORGE_DUMP_ROOT_PATH,
  dumpForgeConversation,
  forgeAgentIdForInteractionMode,
  forgeToolLifecycleItemType,
  forgeToolLifecycleTitle,
  toForgeThreadTokenUsageSnapshot,
} from "../forgecodeRuntime.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = "forgecode" as const;

interface ForgeResumeCursor {
  readonly conversationId?: string;
  readonly cwd?: string;
  readonly executionBackend?: ForgeExecutionTarget["executionBackend"];
  readonly wslDistro?: string;
}

interface ForgeTurnState {
  readonly turnId: TurnId;
  readonly index: number;
  readonly interactionMode: ProviderInteractionMode;
  readonly agentId: "forge" | "muse";
  readonly resolvedModel: ForgeResolvedModel;
  readonly startedAt: string;
  readonly projectedToolStateByCallId: Map<string, ForgeProjectedToolState>;
  process?: ForgeSpawnedProcess;
  interrupted: boolean;
  interruptState?: "interrupted" | "cancelled";
  streamedAssistantText: string;
  streamingClosed: boolean;
}

interface ForgeProjectedToolState {
  readonly itemId: RuntimeItemId;
  lastInProgressFingerprint?: string;
  lastCompletedFingerprint?: string;
}

interface ForgeSessionContext {
  session: ProviderSession;
  readonly binaryPath: string;
  readonly cliApi: ForgeCliApi;
  readonly conversationId: string;
  readonly executionTarget: ForgeExecutionTarget;
  readonly adapterKey: string;
  cwd: string;
  lastKnownTurnCount: number;
  lastAssistantText?: string;
  activeTurn: ForgeTurnState | undefined;
  stopRequested: boolean;
  stopped: boolean;
}

export interface ForgeAdapterLiveOptions {
  readonly cliApiFactory?: (executionTarget: ForgeExecutionTarget) => ForgeCliApi;
  readonly dumpRootPath?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventId() {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function runtimeItemId(value: string) {
  return RuntimeItemId.makeUnsafe(value);
}

function forgeTurnId(conversationId: string, index: number): TurnId {
  return TurnId.makeUnsafe(`forgecode-turn:${conversationId}:${index}`);
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateDetail(value: string | undefined, limit = 1_500): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}...` : trimmed;
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
      // Fall back to the default message.
    }
  }
  return fallback;
}

function readResumeCursor(resumeCursor: unknown): ForgeResumeCursor | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }

  const record = resumeCursor as Record<string, unknown>;
  const conversationId =
    typeof record.conversationId === "string"
      ? record.conversationId
      : typeof record.conversationID === "string"
        ? record.conversationID
        : typeof record.id === "string"
          ? record.id
          : undefined;
  const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
  const executionBackend =
    record.executionBackend === "native" ||
    record.executionBackend === "wsl" ||
    record.executionBackend === "gitbash"
      ? record.executionBackend
      : undefined;
  const wslDistro = typeof record.wslDistro === "string" ? record.wslDistro : undefined;

  return {
    ...(conversationId ? { conversationId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(executionBackend ? { executionBackend } : {}),
    ...(wslDistro ? { wslDistro } : {}),
  };
}

function resumeCursorFromContext(
  context: Pick<ForgeSessionContext, "conversationId" | "cwd" | "executionTarget">,
): ForgeResumeCursor {
  return {
    conversationId: context.conversationId,
    cwd: context.cwd,
    executionBackend: context.executionTarget.executionBackend,
    ...(context.executionTarget.executionBackend === "wsl" && context.executionTarget.wslDistro
      ? { wslDistro: context.executionTarget.wslDistro }
      : {}),
  };
}

function forgeDirectoryForExecutionTarget(
  executionTarget: ForgeExecutionTarget,
  cwd: string,
): string {
  return executionTarget.executionBackend === "wsl" ? toWslPath(cwd) : cwd;
}

function preferredProviderIdFromModel(model: string | undefined): string | undefined {
  const direct = splitForgeModelSlug(model);
  return direct?.providerId;
}

function parseForgeAgentIds(output: string): ReadonlySet<string> {
  return new Set(
    parseForgePorcelainTable(output)
      .map((row) => trimString(row.id))
      .filter((value): value is string => value !== undefined),
  );
}

function waitForSpawnedForgeProcess(spawned: ForgeSpawnedProcess): Promise<ProcessRunResult> {
  return new Promise<ProcessRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    spawned.process.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString();
    });
    spawned.process.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
    });

    spawned.process.once("error", (error) => reject(error));
    spawned.process.once("close", (code, signal) => {
      resolve({
        stdout,
        stderr,
        code,
        signal,
        timedOut: false,
      });
    });
  });
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
  threadId: string,
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

function toUnsupportedRequestError(method: string, detail: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
  });
}

function latestForgeTurn(
  turns: ReadonlyArray<ForgeParsedTurn>,
  index: number,
): ForgeParsedTurn | undefined {
  return turns.find((turn) => turn.index === index) ?? turns.at(-1);
}

function normalizeForgeAssistantText(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.replace(/\r\n/g, "\n");
}

function assistantItemIdForTurn(
  context: ForgeSessionContext,
  turnState: ForgeTurnState,
): RuntimeItemId {
  return runtimeItemId(
    `forgecode-item:${context.conversationId}:turn:${turnState.index}:assistant`,
  );
}

function computeAppendedTextDelta(
  previousText: string,
  nextText: string | undefined,
): string | undefined {
  const normalizedNextText = normalizeForgeAssistantText(nextText);
  if (!normalizedNextText || normalizedNextText.length === 0) {
    return undefined;
  }
  if (previousText.length === 0) {
    return normalizedNextText;
  }
  if (
    !normalizedNextText.startsWith(previousText) ||
    normalizedNextText.length === previousText.length
  ) {
    return undefined;
  }
  return normalizedNextText.slice(previousText.length);
}

function projectionFingerprint(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function toolInProgressFingerprint(
  toolCall: ForgeParsedTurn["toolCalls"][number],
): string | undefined {
  return projectionFingerprint({
    detail: truncateDetail(toolCall.detail),
    input: toolCall.args,
  });
}

function toolCompletedFingerprint(
  toolCall: ForgeParsedTurn["toolCalls"][number],
): string | undefined {
  return projectionFingerprint({
    detail: truncateDetail(toolCall.detail ?? toolCall.result?.text),
    input: toolCall.args,
    result: toolCall.result
      ? {
          callId: toolCall.result.callId,
          isError: toolCall.result.isError,
          name: toolCall.result.name,
          text: truncateDetail(toolCall.result.text),
        }
      : null,
  });
}

function exactForgeTurn(
  turns: ReadonlyArray<ForgeParsedTurn>,
  index: number,
): ForgeParsedTurn | undefined {
  return turns.find((turn) => turn.index === index);
}

function threadSnapshotFromTurns(
  threadId: ProviderSession["threadId"],
  conversationId: string,
  turns: ReadonlyArray<ForgeParsedTurn>,
): ProviderThreadSnapshot {
  return {
    threadId,
    turns: turns.map((turn) => ({
      id: forgeTurnId(conversationId, turn.index),
      items: [...turn.rawMessages],
    })),
  };
}

const FORGE_LIVE_ASSISTANT_POLL_INTERVAL = "250 millis";

const makeForgeAdapter = Effect.fn("makeForgeAdapter")(function* (
  options?: ForgeAdapterLiveOptions,
) {
  const services = yield* Effect.services();
  const runFork = Effect.runForkWith(services);
  const serverSettingsService = yield* ServerSettingsService;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const createCliApi = options?.cliApiFactory ?? createForgeCliApi;
  const dumpRootPath = options?.dumpRootPath ?? DEFAULT_FORGE_DUMP_ROOT_PATH;
  const sessions = new Map<ProviderSession["threadId"], ForgeSessionContext>();

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const emitRuntimeEvent = (
    context: ForgeSessionContext,
    event: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt">,
  ) =>
    emit({
      eventId: eventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      ...event,
    } as ProviderRuntimeEvent);

  const resolveForgeSettings = Effect.fn("resolveForgeSettings")(function* () {
    return yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.forgecode),
      Effect.mapError((cause) => toRequestError("settings.get", cause)),
    );
  });

  const resolveSessionExecutionTarget = Effect.fn("resolveSessionExecutionTarget")(
    function* (input: {
      readonly forgeSettings: {
        readonly binaryPath: string;
        readonly executionBackend: ForgeExecutionTarget["executionBackend"];
      };
      readonly resumeCursor?: ForgeResumeCursor;
    }) {
      const requestedBackend =
        input.resumeCursor?.executionBackend ?? input.forgeSettings.executionBackend;
      return yield* Effect.tryPromise({
        try: () =>
          resolveForgeExecutionTarget({
            executionBackend: requestedBackend,
            ...(input.resumeCursor?.wslDistro ? { wslDistro: input.resumeCursor.wslDistro } : {}),
          }),
        catch: (cause) =>
          toValidationError(
            "startSession",
            `ForgeCode backend '${requestedBackend}' is unavailable: ${toMessage(cause, "Unknown backend error.")}`,
          ),
      });
    },
  );

  const requireSession = (threadId: ProviderSession["threadId"]) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        });
      }
      return context;
    });

  const finalizeStoppedSession = Effect.fn("finalizeStoppedSession")(function* (
    context: ForgeSessionContext,
    options: {
      readonly emitExitEvent: boolean;
    },
  ) {
    if (context.stopped) {
      return;
    }

    context.stopped = true;
    context.stopRequested = false;
    context.activeTurn = undefined;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt: nowIso(),
    };
    sessions.delete(context.session.threadId);

    if (options.emitExitEvent) {
      yield* emitRuntimeEvent(context, {
        type: "session.exited",
        payload: {
          reason: "ForgeCode session stopped.",
          recoverable: true,
          exitKind: "graceful",
        },
      });
    }
  });

  const readConversation = Effect.fn("readConversation")(function* (context: ForgeSessionContext) {
    return yield* Effect.tryPromise({
      try: () =>
        dumpForgeConversation({
          binaryPath: context.binaryPath,
          conversationId: context.conversationId,
          cliApi: context.cliApi,
          dumpRootPath,
        }),
      catch: (cause) =>
        toProcessError(
          context.session.threadId,
          `Failed to export Forge conversation '${context.conversationId}'.`,
          cause,
        ),
    });
  });

  const emitLiveAssistantDelta = Effect.fn("emitLiveAssistantDelta")(function* (
    context: ForgeSessionContext,
    turnState: ForgeTurnState,
    delta: string,
  ) {
    if (turnState.interactionMode === "plan") {
      yield* emitRuntimeEvent(context, {
        type: "turn.proposed.delta",
        turnId: turnState.turnId,
        payload: {
          delta,
        },
      });
      return;
    }

    yield* emitRuntimeEvent(context, {
      type: "content.delta",
      turnId: turnState.turnId,
      itemId: assistantItemIdForTurn(context, turnState),
      payload: {
        streamKind: "assistant_text",
        delta,
      },
    });
  });

  const emitProjectedToolProgress = Effect.fn("emitProjectedToolProgress")(function* (
    context: ForgeSessionContext,
    turnState: ForgeTurnState,
    toolCall: ForgeParsedTurn["toolCalls"][number],
    rawSource: "forge.cli.dump",
  ) {
    const itemId = runtimeItemId(
      `forgecode-item:${context.conversationId}:turn:${turnState.index}:tool:${toolCall.callId}`,
    );
    const itemType = forgeToolLifecycleItemType(toolCall.name);
    const itemTitle = forgeToolLifecycleTitle(toolCall.name);
    const existingState = turnState.projectedToolStateByCallId.get(toolCall.callId);

    if (!existingState) {
      turnState.projectedToolStateByCallId.set(toolCall.callId, { itemId });
      yield* emitRuntimeEvent(context, {
        type: "item.started",
        turnId: turnState.turnId,
        itemId,
        payload: {
          itemType,
          status: "inProgress",
          title: itemTitle,
          ...(toolCall.detail ? { detail: truncateDetail(toolCall.detail) } : {}),
          data: {
            toolName: toolCall.name,
            callId: toolCall.callId,
            input: toolCall.args,
          },
        },
        raw: {
          source: rawSource,
          payload: toolCall,
        },
      });
    }

    const projectedState = turnState.projectedToolStateByCallId.get(toolCall.callId) ?? { itemId };
    if (!toolCall.result) {
      const nextFingerprint = toolInProgressFingerprint(toolCall);
      if (!nextFingerprint || projectedState.lastInProgressFingerprint === nextFingerprint) {
        return;
      }

      turnState.projectedToolStateByCallId.set(toolCall.callId, {
        ...projectedState,
        lastInProgressFingerprint: nextFingerprint,
      });
      yield* emitRuntimeEvent(context, {
        type: "item.updated",
        turnId: turnState.turnId,
        itemId,
        payload: {
          itemType,
          status: "inProgress",
          title: itemTitle,
          ...(toolCall.detail ? { detail: truncateDetail(toolCall.detail) } : {}),
          data: {
            toolName: toolCall.name,
            callId: toolCall.callId,
            input: toolCall.args,
          },
        },
        raw: {
          source: rawSource,
          payload: toolCall,
        },
      });
      return;
    }

    const completedFingerprint = toolCompletedFingerprint(toolCall);
    if (completedFingerprint && projectedState.lastCompletedFingerprint === completedFingerprint) {
      return;
    }

    turnState.projectedToolStateByCallId.set(toolCall.callId, {
      ...projectedState,
      ...(completedFingerprint ? { lastCompletedFingerprint: completedFingerprint } : {}),
    });
    yield* emitRuntimeEvent(context, {
      type: "item.completed",
      turnId: turnState.turnId,
      itemId,
      payload: {
        itemType,
        status: toolCall.result.isError ? "failed" : "completed",
        title: itemTitle,
        ...(truncateDetail(toolCall.detail ?? toolCall.result.text)
          ? { detail: truncateDetail(toolCall.detail ?? toolCall.result.text) }
          : {}),
        data: {
          toolName: toolCall.name,
          callId: toolCall.callId,
          input: toolCall.args,
          result: toolCall.result,
        },
      },
      raw: {
        source: rawSource,
        payload: toolCall,
      },
    });
  });

  const emitProjectedAssistantProgress = Effect.fn("emitProjectedAssistantProgress")(function* (
    context: ForgeSessionContext,
    turnState: ForgeTurnState,
    parsedTurn: ForgeParsedTurn,
  ) {
    const remainingAssistantDelta = computeAppendedTextDelta(
      turnState.streamedAssistantText,
      parsedTurn.assistantText,
    );
    if (!remainingAssistantDelta || remainingAssistantDelta.length === 0) {
      return;
    }

    yield* emitLiveAssistantDelta(context, turnState, remainingAssistantDelta);
    turnState.streamedAssistantText += remainingAssistantDelta;
  });

  const streamLiveAssistant = Effect.fn("streamLiveAssistant")(function* (
    context: ForgeSessionContext,
    turnState: ForgeTurnState,
  ) {
    while (
      !turnState.streamingClosed &&
      !turnState.interrupted &&
      !context.stopped &&
      context.activeTurn === turnState
    ) {
      const conversationResult = yield* readConversation(context).pipe(Effect.result);
      if (Result.isSuccess(conversationResult)) {
        const parsedTurn = exactForgeTurn(conversationResult.success.turns, turnState.index);
        if (parsedTurn) {
          for (const toolCall of parsedTurn.toolCalls) {
            yield* emitProjectedToolProgress(context, turnState, toolCall, "forge.cli.dump");
          }
          yield* emitProjectedAssistantProgress(context, turnState, parsedTurn);
        }
      }

      if (
        turnState.streamingClosed ||
        turnState.interrupted ||
        context.stopped ||
        context.activeTurn !== turnState
      ) {
        return;
      }
      yield* Effect.sleep(FORGE_LIVE_ASSISTANT_POLL_INTERVAL);
    }
  });

  const emitProjectedTurn = Effect.fn("emitProjectedTurn")(function* (
    context: ForgeSessionContext,
    turnState: ForgeTurnState,
    parsedTurn: ForgeParsedTurn,
  ) {
    for (const toolCall of parsedTurn.toolCalls) {
      yield* emitProjectedToolProgress(context, turnState, toolCall, "forge.cli.dump");
    }

    if (parsedTurn.assistantText.trim().length > 0) {
      if (turnState.interactionMode === "plan") {
        yield* emitRuntimeEvent(context, {
          type: "turn.proposed.completed",
          turnId: turnState.turnId,
          payload: {
            planMarkdown: parsedTurn.assistantText.trim(),
          },
          raw: {
            source: "forge.cli.dump",
            payload: parsedTurn,
          },
        });
      } else {
        const assistantItemId = assistantItemIdForTurn(context, turnState);
        yield* emitProjectedAssistantProgress(context, turnState, parsedTurn);
        yield* emitRuntimeEvent(context, {
          type: "item.completed",
          turnId: turnState.turnId,
          itemId: assistantItemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            detail: truncateDetail(parsedTurn.assistantText),
          },
          raw: {
            source: "forge.cli.dump",
            payload: parsedTurn,
          },
        });
      }
    }

    if (parsedTurn.usage) {
      yield* emitRuntimeEvent(context, {
        type: "thread.token-usage.updated",
        turnId: turnState.turnId,
        payload: {
          usage: toForgeThreadTokenUsageSnapshot(parsedTurn.usage),
        },
        raw: {
          source: "forge.cli.dump",
          payload: parsedTurn.usage.raw,
        },
      });
    }
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ForgeSessionContext,
    turnState: ForgeTurnState,
    processResult: ProcessRunResult,
  ) {
    if (context.stopped && !context.stopRequested) {
      return;
    }

    const wasInterrupted = turnState.interrupted === true;
    let parsedTurn: ForgeParsedTurn | undefined;
    let conversationTitle: string | undefined;
    let completionState: "completed" | "failed" | "interrupted" | "cancelled" = wasInterrupted
      ? turnState.interruptState === "cancelled"
        ? "cancelled"
        : "interrupted"
      : processResult.code === 0
        ? "completed"
        : "failed";
    let errorDetail = truncateDetail(processResult.stderr) ?? truncateDetail(processResult.stdout);
    let totalCostUsd: number | undefined;
    let usageRaw: unknown;

    if (!wasInterrupted) {
      const conversationResult = yield* readConversation(context).pipe(Effect.result);
      if (Result.isSuccess(conversationResult)) {
        const conversation = conversationResult.success;
        context.lastKnownTurnCount = conversation.turns.length;
        conversationTitle = conversation.title;
        parsedTurn = latestForgeTurn(conversation.turns, turnState.index);
        const lastAssistantText = normalizeForgeAssistantText(parsedTurn?.assistantText);
        if (lastAssistantText) {
          context.lastAssistantText = lastAssistantText;
        } else {
          delete context.lastAssistantText;
        }
        totalCostUsd = parsedTurn?.usage?.totalCostUsd;
        usageRaw = parsedTurn?.usage?.raw;
      } else {
        completionState = "failed";
        errorDetail =
          errorDetail ??
          truncateDetail(
            toMessage(
              conversationResult.failure,
              `Failed to read Forge conversation '${context.conversationId}'.`,
            ),
          );
      }
    }

    if (conversationTitle) {
      yield* emitRuntimeEvent(context, {
        type: "thread.metadata.updated",
        payload: {
          name: conversationTitle,
          metadata: {
            conversationId: context.conversationId,
          },
        },
      });
    }

    if (wasInterrupted) {
      yield* emitRuntimeEvent(context, {
        type: "turn.aborted",
        turnId: turnState.turnId,
        payload: {
          reason:
            turnState.interruptState === "cancelled"
              ? "ForgeCode turn cancelled."
              : "ForgeCode turn interrupted.",
        },
      });
    } else if (parsedTurn) {
      yield* emitProjectedTurn(context, turnState, parsedTurn);
      if (processResult.code !== 0) {
        yield* emitRuntimeEvent(context, {
          type: "runtime.error",
          turnId: turnState.turnId,
          payload: {
            message:
              errorDetail ??
              `ForgeCode exited with code ${processResult.code ?? "null"} while processing the turn.`,
            class: "provider_error",
            detail: {
              exitCode: processResult.code,
              signal: processResult.signal,
              stdout: processResult.stdout,
              stderr: processResult.stderr,
            },
          },
        });
      }
    } else if (completionState === "failed") {
      yield* emitRuntimeEvent(context, {
        type: "runtime.error",
        turnId: turnState.turnId,
        payload: {
          message:
            errorDetail ??
            `ForgeCode exited with code ${processResult.code ?? "null"} and returned no readable conversation output.`,
          class: "provider_error",
          detail: {
            exitCode: processResult.code,
            signal: processResult.signal,
            stdout: processResult.stdout,
            stderr: processResult.stderr,
          },
        },
      });
    }

    context.activeTurn = undefined;
    context.session = {
      ...context.session,
      status: completionState === "failed" ? "error" : "ready",
      activeTurnId: undefined,
      updatedAt: nowIso(),
      ...(completionState === "failed" && errorDetail
        ? { lastError: errorDetail }
        : { lastError: undefined }),
    };

    yield* emitRuntimeEvent(context, {
      type: "turn.completed",
      turnId: turnState.turnId,
      payload: {
        state: completionState,
        ...(usageRaw !== undefined ? { usage: usageRaw } : {}),
        ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
        ...(completionState === "failed" && errorDetail ? { errorMessage: errorDetail } : {}),
      },
    });

    if (context.stopRequested) {
      yield* finalizeStoppedSession(context, { emitExitEvent: true });
    }
  });

  const monitorTurn = Effect.fn("monitorTurn")(function* (
    context: ForgeSessionContext,
    turnState: ForgeTurnState,
  ) {
    if (!turnState.process) {
      return;
    }

    const processResult = yield* Effect.tryPromise({
      try: () => waitForSpawnedForgeProcess(turnState.process!),
      catch: (cause) =>
        toProcessError(
          context.session.threadId,
          `ForgeCode process failed for turn '${turnState.turnId}'.`,
          cause,
        ),
    }).pipe(Effect.result);

    if (Result.isSuccess(processResult)) {
      turnState.streamingClosed = true;
      yield* completeTurn(context, turnState, processResult.success);
      return;
    }

    turnState.streamingClosed = true;
    context.activeTurn = undefined;
    context.session = {
      ...context.session,
      status: "error",
      activeTurnId: undefined,
      updatedAt: nowIso(),
      lastError: truncateDetail(processResult.failure.message),
    };

    yield* emitRuntimeEvent(context, {
      type: "runtime.error",
      turnId: turnState.turnId,
      payload: {
        message: truncateDetail(processResult.failure.message) ?? "ForgeCode process failed.",
        class: "provider_error",
      },
    });
    yield* emitRuntimeEvent(context, {
      type: "turn.completed",
      turnId: turnState.turnId,
      payload: {
        state: turnState.interrupted
          ? turnState.interruptState === "cancelled"
            ? "cancelled"
            : "interrupted"
          : "failed",
        ...(turnState.interrupted
          ? {}
          : {
              errorMessage:
                truncateDetail(processResult.failure.message) ?? "ForgeCode process failed.",
            }),
      },
    });

    if (context.stopRequested) {
      yield* finalizeStoppedSession(context, { emitExitEvent: true });
    }
  });

  const validateAgentAvailable = Effect.fn("validateAgentAvailable")(function* (
    context: ForgeSessionContext,
    agentId: "forge" | "muse",
  ) {
    const agentResult = yield* Effect.tryPromise({
      try: () =>
        context.cliApi.run({
          binaryPath: context.binaryPath,
          args: ["list", "agent", "--porcelain"],
        }),
      catch: (cause) => toRequestError("forge list agent", cause),
    });
    const agentIds = parseForgeAgentIds(agentResult.stdout);
    if (!agentIds.has(agentId)) {
      return yield* toValidationError(
        "sendTurn",
        `ForgeCode agent '${agentId}' is not available in the installed CLI.`,
      );
    }
  });

  const resolveTurnModel = Effect.fn("resolveTurnModel")(function* (
    context: ForgeSessionContext,
    input: ProviderSendTurnInput,
  ) {
    if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
      return yield* toValidationError(
        "sendTurn",
        `Expected provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
      );
    }

    const modelResult = yield* Effect.tryPromise({
      try: () =>
        context.cliApi.run({
          binaryPath: context.binaryPath,
          args: ["list", "model", "--porcelain"],
        }),
      catch: (cause) => toRequestError("forge list model", cause),
    });
    const catalog = parseForgeModelCatalogRows(modelResult.stdout);
    if (catalog.length === 0) {
      return yield* toValidationError(
        "sendTurn",
        "ForgeCode did not report any selectable models from the active provider catalog.",
      );
    }

    const requestedModel = input.modelSelection?.model ?? context.session.model;
    if (requestedModel) {
      const resolved = resolveForgeModel(requestedModel, catalog);
      if (!resolved) {
        const ambiguousMatches = catalog.filter((entry) => entry.id === requestedModel.trim());
        const issue =
          ambiguousMatches.length > 1
            ? `ForgeCode model '${requestedModel}' is ambiguous across multiple upstream providers. Pick a provider-qualified model such as '${buildForgeModelSlug(ambiguousMatches[0]!.providerId, ambiguousMatches[0]!.id)}'.`
            : `Could not resolve ForgeCode model '${requestedModel}' against the active provider catalog.`;
        return yield* toValidationError("sendTurn", issue);
      }
      return resolved;
    }

    const fallback = resolveFallbackForgeModel(
      catalog,
      preferredProviderIdFromModel(context.session.model),
    );
    if (!fallback) {
      return yield* toValidationError(
        "sendTurn",
        "ForgeCode could not resolve a fallback model from the active provider catalog.",
      );
    }
    return fallback;
  });

  const resolveConfiguredModel = Effect.fn("resolveConfiguredModel")(function* (input: {
    readonly binaryPath: string;
    readonly cliApi: ForgeCliApi;
    readonly requestedModel?: string;
  }) {
    const requestedModel = trimString(input.requestedModel);
    if (!requestedModel) {
      return undefined;
    }

    const modelResult = yield* Effect.tryPromise({
      try: () =>
        input.cliApi.run({
          binaryPath: input.binaryPath,
          args: ["list", "model", "--porcelain"],
        }),
      catch: (cause) => toRequestError("forge list model", cause),
    });
    const catalog = parseForgeModelCatalogRows(modelResult.stdout);
    if (catalog.length === 0) {
      return yield* toValidationError(
        "startSession",
        "ForgeCode did not report any selectable models from the active provider catalog.",
      );
    }

    const resolved = resolveForgeModel(requestedModel, catalog);
    if (!resolved) {
      const ambiguousMatches = catalog.filter((entry) => entry.id === requestedModel.trim());
      const issue =
        ambiguousMatches.length > 1
          ? `ForgeCode model '${requestedModel}' is ambiguous across multiple upstream providers. Pick a provider-qualified model such as '${buildForgeModelSlug(ambiguousMatches[0]!.providerId, ambiguousMatches[0]!.id)}'.`
          : `Could not resolve ForgeCode model '${requestedModel}' against the active provider catalog.`;
      return yield* toValidationError("startSession", issue);
    }
    return resolved;
  });

  const startSession: ForgeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* toValidationError(
          "startSession",
          `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        );
      }
      if (input.runtimeMode === "approval-required") {
        return yield* toValidationError(
          "startSession",
          "ForgeCode does not support T3 interactive approval-required mode.",
        );
      }
      if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
        return yield* toValidationError(
          "startSession",
          `Expected provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
        );
      }

      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        return existing.session;
      }

      const forgeSettings = yield* resolveForgeSettings();
      const resumeCursor = readResumeCursor(input.resumeCursor);
      const executionTarget = yield* resolveSessionExecutionTarget({
        forgeSettings,
        ...(resumeCursor ? { resumeCursor } : {}),
      });
      const sessionCliApi = createCliApi(executionTarget);
      const conversationId = resumeCursor?.conversationId ?? createForgeConversationId();
      const cwd = trimString(input.cwd ?? resumeCursor?.cwd);
      if (!cwd) {
        return yield* toValidationError(
          "startSession",
          "ForgeCode sessions require a cwd or a resume cursor with cwd.",
        );
      }
      const resolvedSessionModel = yield* resolveConfiguredModel({
        binaryPath: forgeSettings.binaryPath,
        cliApi: sessionCliApi,
        ...(input.modelSelection?.model ? { requestedModel: input.modelSelection.model } : {}),
      });

      let existingTurns = 0;
      let lastAssistantText: string | undefined;
      if (resumeCursor?.conversationId) {
        const resumeResult = yield* Effect.tryPromise({
          try: () =>
            dumpForgeConversation({
              binaryPath: forgeSettings.binaryPath,
              conversationId: resumeCursor.conversationId!,
              cliApi: sessionCliApi,
              dumpRootPath,
            }),
          catch: (cause) =>
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
              cause,
            }),
        });
        existingTurns = resumeResult.turns.length;
        lastAssistantText = normalizeForgeAssistantText(resumeResult.turns.at(-1)?.assistantText);
      }

      const createdAt = nowIso();
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(resolvedSessionModel ? { model: resolvedSessionModel.slug } : {}),
        threadId: input.threadId,
        resumeCursor: resumeCursorFromContext({
          conversationId,
          cwd,
          executionTarget,
        }),
        createdAt,
        updatedAt: createdAt,
      };

      const context: ForgeSessionContext = {
        session,
        binaryPath: forgeSettings.binaryPath,
        cliApi: sessionCliApi,
        conversationId,
        executionTarget,
        adapterKey: buildForgeAdapterKey(executionTarget),
        cwd,
        lastKnownTurnCount: existingTurns,
        ...(lastAssistantText ? { lastAssistantText } : {}),
        activeTurn: undefined,
        stopRequested: false,
        stopped: false,
      };
      sessions.set(input.threadId, context);

      yield* emitRuntimeEvent(context, {
        type: "session.started",
        payload: {
          message: "ForgeCode session started.",
          resume: session.resumeCursor,
        },
      });
      yield* emitRuntimeEvent(context, {
        type: "thread.started",
        payload: {
          providerThreadId: conversationId,
        },
      });
      yield* emitRuntimeEvent(context, {
        type: "session.configured",
        payload: {
          config: {
            binaryPath: forgeSettings.binaryPath,
            cwd,
            conversationId,
            executionBackend: executionTarget.executionBackend,
            ...(executionTarget.wslDistro ? { wslDistro: executionTarget.wslDistro } : {}),
            runtimeMode: input.runtimeMode,
          },
        },
      });
      yield* emitRuntimeEvent(context, {
        type: "session.state.changed",
        payload: {
          state: "ready",
        },
      });

      return context.session;
    },
  );

  const sendTurn: ForgeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (context.session.runtimeMode === "approval-required") {
      return yield* toValidationError(
        "sendTurn",
        "ForgeCode does not support T3 interactive approval-required mode.",
      );
    }
    if (context.activeTurn) {
      return yield* toRequestError(
        "forge --prompt",
        new Error("Cannot send a new ForgeCode turn while another turn is still running."),
      );
    }
    if ((input.attachments ?? []).length > 0) {
      return yield* toValidationError(
        "sendTurn",
        "ForgeCode attachments are not supported in T3 Code v1.",
      );
    }

    const prompt = trimString(input.input);
    if (!prompt) {
      return yield* toValidationError("sendTurn", "ForgeCode requires non-empty input text.");
    }

    const resolvedModel = yield* resolveTurnModel(context, input);
    const agentId = forgeAgentIdForInteractionMode(input.interactionMode);
    yield* validateAgentAvailable(context, agentId);

    const turnIndex = context.lastKnownTurnCount + 1;
    const turnId = forgeTurnId(context.conversationId, turnIndex);
    const turnState: ForgeTurnState = {
      turnId,
      index: turnIndex,
      interactionMode: input.interactionMode ?? "default",
      agentId,
      resolvedModel,
      startedAt: nowIso(),
      projectedToolStateByCallId: new Map(),
      interrupted: false,
      streamedAssistantText: "",
      streamingClosed: false,
    };

    const spawned = yield* Effect.try({
      try: () =>
        context.cliApi.spawn({
          binaryPath: context.binaryPath,
          cwd: context.cwd,
          args: [
            "--prompt",
            prompt,
            "--conversation-id",
            context.conversationId,
            "--agent",
            agentId,
            "--directory",
            forgeDirectoryForExecutionTarget(context.executionTarget, context.cwd),
          ],
          env: {
            FORGE_SESSION__PROVIDER_ID: resolvedModel.providerId,
            FORGE_SESSION__MODEL_ID: resolvedModel.modelId,
          },
        }),
      catch: (cause) =>
        toProcessError(
          context.session.threadId,
          "Failed to start the ForgeCode subprocess.",
          cause,
        ),
    });

    turnState.process = spawned;
    context.activeTurn = turnState;
    context.session = {
      ...context.session,
      status: "running",
      model: resolvedModel.slug,
      activeTurnId: turnId,
      updatedAt: nowIso(),
      lastError: undefined,
      resumeCursor: resumeCursorFromContext(context),
    };

    yield* emitRuntimeEvent(context, {
      type: "turn.started",
      turnId,
      payload: {
        model: resolvedModel.slug,
      },
    });

    runFork(streamLiveAssistant(context, turnState));
    runFork(monitorTurn(context, turnState));

    return {
      threadId: context.session.threadId,
      turnId,
      resumeCursor: resumeCursorFromContext(context),
    };
  });

  const interruptTurn: ForgeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, turnId) {
      const context = yield* requireSession(threadId);
      const activeTurn = context.activeTurn;
      if (!activeTurn) {
        return;
      }
      if (turnId && activeTurn.turnId !== turnId) {
        return;
      }

      activeTurn.interrupted = true;
      activeTurn.interruptState = "interrupted";
      activeTurn.streamingClosed = true;
      activeTurn.process?.kill();
    },
  );

  const respondToRequest: ForgeAdapterShape["respondToRequest"] = (_threadId) =>
    Effect.fail(
      toUnsupportedRequestError(
        "respondToRequest",
        "ForgeCode does not expose T3-compatible interactive approval requests.",
      ),
    );

  const respondToUserInput: ForgeAdapterShape["respondToUserInput"] = (_threadId) =>
    Effect.fail(
      toUnsupportedRequestError(
        "respondToUserInput",
        "ForgeCode does not expose T3-compatible structured user-input requests.",
      ),
    );

  const readThread: ForgeAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
    const context = yield* requireSession(threadId);
    if (context.lastKnownTurnCount === 0) {
      return {
        threadId,
        turns: [],
      };
    }

    const conversation = yield* readConversation(context);
    context.lastKnownTurnCount = conversation.turns.length;
    const lastAssistantText = normalizeForgeAssistantText(conversation.turns.at(-1)?.assistantText);
    if (lastAssistantText) {
      context.lastAssistantText = lastAssistantText;
    } else {
      delete context.lastAssistantText;
    }
    return threadSnapshotFromTurns(threadId, context.conversationId, conversation.turns);
  });

  const rollbackThread: ForgeAdapterShape["rollbackThread"] = () =>
    Effect.fail(
      toUnsupportedRequestError(
        "rollbackThread",
        "ForgeCode rollback is not supported by this T3 harness.",
      ),
    );

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ForgeSessionContext,
    options: {
      readonly emitExitEvent: boolean;
    },
  ) {
    if (context.stopped) {
      return;
    }

    if (context.activeTurn) {
      if (!options.emitExitEvent) {
        context.stopped = true;
        context.stopRequested = false;
        context.activeTurn.streamingClosed = true;
        context.activeTurn.process?.kill();
        sessions.delete(context.session.threadId);
        return;
      }

      context.stopRequested = true;
      context.activeTurn.interrupted = true;
      context.activeTurn.interruptState = "cancelled";
      context.activeTurn.streamingClosed = true;
      context.activeTurn.process?.kill();
      return;
    }

    yield* finalizeStoppedSession(context, options);
  });

  const stopSession: ForgeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, { emitExitEvent: true });
    },
  );

  const listSessions: ForgeAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      Array.from(sessions.values(), ({ session, stopped }) =>
        stopped ? null : { ...session },
      ).filter((session): session is ProviderSession => session !== null),
    );

  const hasSession: ForgeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ForgeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      Array.from(sessions.values()),
      (context) => stopSessionInternal(context, { emitExitEvent: true }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      Array.from(sessions.values()),
      (context) => stopSessionInternal(context, { emitExitEvent: false }),
      { discard: true },
    ).pipe(Effect.andThen(Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      busyFollowupMode: "queue-only",
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
  } satisfies ForgeAdapterShape;
});

export const ForgeAdapterLive = Layer.effect(ForgeAdapter, makeForgeAdapter());

export function makeForgeAdapterLive(options?: ForgeAdapterLiveOptions) {
  return Layer.effect(ForgeAdapter, makeForgeAdapter(options));
}
