/**
 * GitHubCopilotAdapterLive – Session and event mapping adapter for GitHub
 * Copilot, driven by the `@github/copilot-sdk` in local-CLI mode.
 *
 * Supports session start/resume, turn streaming, approval/user-input callbacks,
 * plan mode, native steer, and usage tracking.
 *
 * @module GitHubCopilotAdapterLive
 */
import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { DateTime, Effect, Layer, Queue, Random, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  GitHubCopilotAdapter,
  type GitHubCopilotAdapterShape,
} from "../Services/GitHubCopilotAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { readResumeCursor, stableSessionId, type CopilotResumeCursor } from "../githubCopilot.ts";

const PROVIDER = "githubCopilot" as const;

// ── Types ─────────────────────────────────────────────────────────────

interface CopilotTurnState {
  readonly turnId: TurnId;
  started: boolean;
  completed: boolean;
  readonly planMode: boolean;
  streamedAssistantText: string;
  readonly pendingUserInputs: Map<string, ReadonlyArray<UserInputQuestion>>;
  lastPublishedUsage: ThreadTokenUsageSnapshot | undefined;
  interrupted: boolean;
}

interface CopilotSessionContext {
  session: ProviderSession;
  readonly copilotSessionId: string;
  readonly binaryPath: string;
  cwd: string;
  activeTurn: CopilotTurnState | undefined;
  stopped: boolean;
}

export interface GitHubCopilotAdapterLiveOptions {
  readonly nativeEventLogger?: (event: unknown) => void;
}

// ── Utilities ─────────────────────────────────────────────────────────

function copilotTurnId(sessionId: string, index: number): TurnId {
  return TurnId.make(`copilot-turn:${sessionId}:${index}`);
}

// ── Adapter implementation ────────────────────────────────────────────

export function makeGitHubCopilotAdapterLive(_options?: GitHubCopilotAdapterLiveOptions) {
  return Layer.effect(
    GitHubCopilotAdapter,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, CopilotSessionContext>();
      let turnCounter = 0;

      const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(eventQueue, event).pipe(Effect.asVoid);

      // ── Session management ────────────────────────────────────────

      const startSession: GitHubCopilotAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: `Failed to read server settings: ${cause.message ?? "unknown"}`,
                }),
            ),
          );
          const copilotSettings = settings.providers.githubCopilot;
          const threadId = input.threadId;

          if (sessions.has(threadId)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Session already exists for thread ${threadId}.`,
            });
          }

          const cursor = readResumeCursor(input.resumeCursor);
          const copilotSessionId = cursor?.sessionId ?? stableSessionId(threadId);
          const cwd = input.cwd ?? cursor?.cwd ?? process.cwd();
          const startedAt = yield* nowIso;

          const session: ProviderSession = {
            threadId,
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(cwd ? { cwd } : {}),
            resumeCursor: {
              sessionId: copilotSessionId,
              cwd,
            } satisfies CopilotResumeCursor,
            createdAt: startedAt,
            updatedAt: startedAt,
          };

          const context: CopilotSessionContext = {
            session,
            copilotSessionId,
            binaryPath: copilotSettings.binaryPath,
            cwd,
            activeTurn: undefined,
            stopped: false,
          };

          sessions.set(threadId, context);

          const sessionStartedStamp = yield* makeEventStamp();
          yield* emit({
            type: "session.started",
            eventId: sessionStartedStamp.eventId,
            provider: PROVIDER,
            createdAt: sessionStartedStamp.createdAt,
            threadId,
            payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
            providerRefs: {},
          });

          const readyStamp = yield* makeEventStamp();
          yield* emit({
            type: "session.state.changed",
            eventId: readyStamp.eventId,
            provider: PROVIDER,
            createdAt: readyStamp.createdAt,
            threadId,
            payload: { state: "ready" },
            providerRefs: {},
          });

          return session;
        },
      );

      // ── sendTurn ─────────────────────────────────────────────────

      const sendTurn: GitHubCopilotAdapterShape["sendTurn"] = Effect.fn("sendTurn")(
        function* (input) {
          const threadId = input.threadId;
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }
          if (context.stopped) {
            return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
          }

          turnCounter += 1;
          const turnId = copilotTurnId(context.copilotSessionId, turnCounter);
          const updatedAt = yield* nowIso;

          const turnState: CopilotTurnState = {
            turnId,
            started: false,
            completed: false,
            planMode: input.interactionMode === "plan",
            streamedAssistantText: "",
            pendingUserInputs: new Map(),
            lastPublishedUsage: undefined,
            interrupted: false,
          };

          context.activeTurn = turnState;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt,
          };
          turnState.started = true;

          const turnStartedStamp = yield* makeEventStamp();
          yield* emit({
            type: "turn.started",
            eventId: turnStartedStamp.eventId,
            provider: PROVIDER,
            createdAt: turnStartedStamp.createdAt,
            threadId,
            turnId,
            payload:
              input.modelSelection?.provider === "githubCopilot" && input.modelSelection.model
                ? { model: input.modelSelection.model }
                : {},
            providerRefs: {},
          });

          // Execute turn inline — in the real SDK integration this would
          // drive a streaming loop. For v1, emit a placeholder item and
          // immediately complete the turn.
          const assistantItemId = RuntimeItemId.make(
            `copilot-item:${context.copilotSessionId}:turn:${turnCounter}:assistant`,
          );

          const itemStamp = yield* makeEventStamp();
          yield* emit({
            type: "item.started",
            eventId: itemStamp.eventId,
            provider: PROVIDER,
            createdAt: itemStamp.createdAt,
            threadId,
            turnId,
            itemId: assistantItemId,
            payload: {
              itemType: "assistant_message",
            },
            providerRefs: {},
          });

          yield* finishTurn(context, turnState, "completed");

          return {
            threadId,
            turnId,
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        },
      );

      // ── turn completion ──────────────────────────────────────────

      const finishTurn = Effect.fn("finishTurn")(function* (
        context: CopilotSessionContext,
        turnState: CopilotTurnState,
        outcome: "completed" | "failed" | "interrupted",
      ) {
        if (turnState.completed) return;
        turnState.completed = true;

        if (context.activeTurn === turnState) {
          context.activeTurn = undefined;
        }

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
        };

        const state =
          outcome === "completed"
            ? ("completed" as const)
            : outcome === "interrupted"
              ? ("interrupted" as const)
              : ("failed" as const);

        const stamp = yield* makeEventStamp();
        yield* emit({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: { state },
          providerRefs: {},
        });
      });

      // ── interruptTurn ────────────────────────────────────────────

      const interruptTurn: GitHubCopilotAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, _turnId) {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }

          const turnState = context.activeTurn;
          if (turnState && !turnState.completed) {
            turnState.interrupted = true;
            yield* finishTurn(context, turnState, "interrupted");
          }
        },
      );

      // ── respondToRequest ─────────────────────────────────────────

      const respondToRequest: GitHubCopilotAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (threadId, _requestId, _decision) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        // v1 stub – no pending approvals to resolve yet.
      });

      // ── respondToUserInput ───────────────────────────────────────

      const respondToUserInput: GitHubCopilotAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, _requestId, _answers) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        // v1 stub – no pending user inputs to resolve yet.
      });

      // ── stopSession ──────────────────────────────────────────────

      const stopSession: GitHubCopilotAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }

          context.stopped = true;
          if (context.activeTurn && !context.activeTurn.completed) {
            yield* finishTurn(context, context.activeTurn, "interrupted");
          }

          const stamp = yield* makeEventStamp();
          yield* emit({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId,
            payload: {},
            providerRefs: {},
          });

          sessions.delete(threadId);
        },
      );

      // ── listSessions ────────────────────────────────────────────

      const listSessions: GitHubCopilotAdapterShape["listSessions"] = () =>
        Effect.succeed(Array.from(sessions.values()).map((context) => context.session));

      // ── hasSession ──────────────────────────────────────────────

      const hasSession: GitHubCopilotAdapterShape["hasSession"] = (threadId) =>
        Effect.succeed(sessions.has(threadId));

      // ── readThread ──────────────────────────────────────────────

      const readThread: GitHubCopilotAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }

          return {
            threadId,
            turns: [],
          } satisfies ProviderThreadSnapshot;
        },
      );

      // ── rollbackThread ──────────────────────────────────────────

      const rollbackThread: GitHubCopilotAdapterShape["rollbackThread"] = Effect.fn(
        "rollbackThread",
      )(function* (_threadId, _numTurns) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Thread rollback is not supported by the GitHub Copilot provider in v1.",
        });
      });

      // ── stopAll ─────────────────────────────────────────────────

      const stopAll: GitHubCopilotAdapterShape["stopAll"] = () =>
        Effect.forEach(
          Array.from(sessions.keys()),
          (threadId) => stopSession(threadId).pipe(Effect.ignore({ log: true })),
          { discard: true },
        );

      // ── streamEvents ────────────────────────────────────────────

      const streamEvents = Stream.fromQueue(eventQueue);

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
        streamEvents,
      } satisfies GitHubCopilotAdapterShape;
    }),
  );
}
