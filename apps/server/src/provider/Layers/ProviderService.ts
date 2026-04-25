/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Schema, SchemaIssue, Stream } from "effect";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { buildForgeAdapterKey, parseForgeAdapterKey } from "../forgecode.ts";
import { buildCursorAdapterKey, parseCursorAdapterKey } from "../cursorAgent.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  provider: ProviderSession["provider"],
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  if (provider === "forgecode") {
    const runtimeModel = "model" in runtimePayload ? runtimePayload.model : undefined;
    if (typeof runtimeModel === "string" && runtimeModel.trim().length > 0) {
      return {
        provider: "forgecode",
        model: runtimeModel.trim(),
      };
    }
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function forgeAdapterKeyFromResumeCursor(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  const executionBackend =
    record.executionBackend === "native" ||
    record.executionBackend === "wsl" ||
    record.executionBackend === "gitbash"
      ? record.executionBackend
      : undefined;
  if (!executionBackend) {
    return undefined;
  }
  return buildForgeAdapterKey({
    executionBackend,
    ...(typeof record.wslDistro === "string" ? { wslDistro: record.wslDistro } : {}),
  });
}

function cursorAdapterKeyFromResumeCursor(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  const executionBackend =
    record.executionBackend === "native" || record.executionBackend === "wsl"
      ? record.executionBackend
      : undefined;
  if (!executionBackend) {
    return undefined;
  }
  return buildCursorAdapterKey({
    executionBackend,
    ...(typeof record.wslDistro === "string" ? { wslDistro: record.wslDistro } : {}),
  });
}

function adapterKeyFromSession(session: ProviderSession): string | undefined {
  if (session.provider === "forgecode") {
    return forgeAdapterKeyFromResumeCursor(session.resumeCursor);
  }
  if (session.provider === "cursorAgent") {
    return cursorAdapterKeyFromResumeCursor(session.resumeCursor);
  }
  return undefined;
}

function augmentCursorResumeCursor(
  provider: ProviderSession["provider"],
  resumeCursor: unknown,
  adapterKey: string | undefined,
): unknown {
  if (provider !== "cursorAgent") {
    return resumeCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    const executionTarget = parseCursorAdapterKey(adapterKey);
    return executionTarget ?? resumeCursor;
  }
  const record = resumeCursor as Record<string, unknown>;
  if (record.executionBackend === "native" || record.executionBackend === "wsl") {
    return resumeCursor;
  }
  const executionTarget = parseCursorAdapterKey(adapterKey);
  if (!executionTarget) {
    return resumeCursor;
  }
  return {
    ...record,
    executionBackend: executionTarget.executionBackend,
    ...(executionTarget.wslDistro ? { wslDistro: executionTarget.wslDistro } : {}),
  };
}

function augmentResumeCursor(
  provider: ProviderSession["provider"],
  resumeCursor: unknown,
  adapterKey: string | undefined,
): unknown {
  if (provider === "forgecode") {
    if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
      const executionTarget = parseForgeAdapterKey(adapterKey);
      return executionTarget ?? resumeCursor;
    }
    const record = resumeCursor as Record<string, unknown>;
    if (
      record.executionBackend === "native" ||
      record.executionBackend === "wsl" ||
      record.executionBackend === "gitbash"
    ) {
      return resumeCursor;
    }
    const executionTarget = parseForgeAdapterKey(adapterKey);
    if (!executionTarget) {
      return resumeCursor;
    }
    return {
      ...record,
      executionBackend: executionTarget.executionBackend,
      ...(executionTarget.wslDistro ? { wslDistro: executionTarget.wslDistro } : {}),
    };
  }
  if (provider === "cursorAgent") {
    return augmentCursorResumeCursor(provider, resumeCursor, adapterKey);
  }
  return resumeCursor;
}

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService);
  const serverSettings = yield* ServerSettingsService;
  const canonicalEventLogger =
    options?.canonicalEventLogger ??
    (options?.canonicalEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
          stream: "canonical",
        })
      : undefined);

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger ? canonicalEventLogger.write(canonicalEvent, null) : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) => {
    const adapterKey = adapterKeyFromSession(session);
    return directory.upsert({
      threadId,
      provider: session.provider,
      ...(adapterKey ? { adapterKey } : {}),
      runtimeMode: session.runtimeMode,
      status: toRuntimeStatus(session),
      ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
      runtimePayload: toRuntimePayloadFromSession(session, extra),
    });
  };

  const providers = yield* registry.listProviders();
  const adapters = yield* Effect.forEach(providers, (provider) => registry.getByProvider(provider));
  const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    increment(providerRuntimeEventsTotal, {
      provider: event.provider,
      eventType: event.type,
    }).pipe(Effect.andThen(publishRuntimeEvent(event)));

  yield* Effect.forEach(adapters, (adapter) =>
    Stream.runForEach(adapter.streamEvents, processRuntimeEvent).pipe(Effect.forkScoped),
  ).pipe(Effect.asVoid);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByProvider(input.binding.provider);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(existing, input.binding.threadId);
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(
        input.binding.provider,
        input.binding.runtimePayload,
      );
      const resumeCursor = augmentResumeCursor(
        input.binding.provider,
        input.binding.resumeCursor,
        input.binding.adapterKey,
      );

      const resumed = yield* adapter.startSession({
        threadId: input.binding.threadId,
        provider: input.binding.provider,
        ...(persistedCwd ? { cwd: persistedCwd } : {}),
        ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
        ...(hasResumeCursor ? { resumeCursor } : {}),
        runtimeMode: input.binding.runtimeMode ?? "full-access",
      });
      if (resumed.provider !== adapter.provider) {
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(resumed, input.binding.threadId);
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const adapter = yield* registry.getByProvider(binding.provider);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return { adapter, threadId: input.threadId, isActive: true } as const;
    }

    if (!input.allowRecovery) {
      return { adapter, threadId: input.threadId, isActive: false } as const;
    }

    const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
    return { adapter: recovered.adapter, threadId: input.threadId, isActive: true } as const;
  });

  const startSession: ProviderServiceShape["startSession"] = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const input = {
        ...parsed,
        threadId,
        provider: parsed.provider ?? "codex",
      };
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.kind": input.provider,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) =>
            toValidationError(
              "ProviderService.startSession",
              `Failed to load provider settings: ${error.message}`,
              error,
            ),
          ),
        );
        if (!settings.providers[input.provider].enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider '${input.provider}' is disabled in NJ Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.provider === input.provider
            ? augmentResumeCursor(
                persistedBinding.provider,
                persistedBinding.resumeCursor,
                persistedBinding.adapterKey,
              )
            : undefined);
        const adapter = yield* registry.getByProvider(input.provider);
        const session = yield* adapter.startSession({
          ...input,
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        });

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* upsertSessionBinding(session, threadId, {
          modelSelection: input.modelSelection,
        });
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return session;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: providerMetricAttributes(input.provider, {
            operation: "start",
          }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      const adapterKey =
        routed.adapter.provider === "forgecode"
          ? forgeAdapterKeyFromResumeCursor(turn.resumeCursor)
          : routed.adapter.provider === "cursorAgent"
            ? cursorAdapterKeyFromResumeCursor(turn.resumeCursor)
            : undefined;
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        ...(adapterKey ? { adapterKey } : {}),
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: new Date().toISOString(),
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* directory.remove(input.threadId);
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceShape["listSessions"] = Effect.fn("listSessions")(
    function* () {
      const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) =>
        adapter.listSessions(),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
      );
      const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      return activeSessions.map((session) => {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          return session;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
        } = {};
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        return Object.assign({}, session, overrides);
      });
    },
  );

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
    registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const activeSessions = yield* Effect.forEach(adapters, (adapter) =>
      adapter.listSessions(),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      upsertSessionBinding(session, session.threadId, {
        lastRuntimeEvent: "provider.stopAll",
        lastRuntimeEventAt: new Date().toISOString(),
      }),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* Effect.forEach(threadIds, (threadId) =>
      directory.getProvider(threadId).pipe(
        Effect.flatMap((provider) =>
          directory.upsert({
            threadId,
            provider,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
              lastRuntimeEvent: "provider.stopAll",
              lastRuntimeEventAt: new Date().toISOString(),
            },
          }),
        ),
      ),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    Effect.catch(runStopAll(), (cause) =>
      Effect.logWarning("failed to stop provider service", { cause }),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
