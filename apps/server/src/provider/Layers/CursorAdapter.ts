/**
 * CursorAdapterLive – Session and event mapping adapter for the Cursor
 * headless CLI (`cursor-agent`), using process-per-turn execution with
 * `--output-format stream-json`.
 *
 * Supports session start/resume, turn streaming, queue-only follow-ups,
 * interrupt via process kill, and best-effort thread recovery.
 *
 * @module CursorAdapterLive
 */
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";

import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  buildCursorAdapterKey,
  resolveCursorAgentApiModelId,
  buildCursorSpawnSpec,
  buildCursorTurnArgs,
  readCursorResumeCursor,
  type CursorExecutionTarget,
  type CursorResumeCursor,
} from "../cursorAgent.ts";
import { parseDefaultWslDistro } from "../forgecode.ts";

const PROVIDER = "cursorAgent" as const;

function eventId() {
  return EventId.make(crypto.randomUUID());
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Types ─────────────────────────────────────────────────────────────

interface CursorTurnState {
  readonly turnId: TurnId;
  started: boolean;
  completed: boolean;
  streamedAssistantText: string;
  interrupted: boolean;
  process?: NodeChildProcess;
}

interface CursorLocalTurnSnapshot {
  readonly turnId: TurnId;
  readonly assistantText: string;
}

interface CursorSessionContext {
  session: ProviderSession;
  readonly binaryPath: string;
  readonly executionTarget: CursorExecutionTarget;
  readonly adapterKey: string;
  cwd: string;
  cursorSessionId: string | undefined;
  activeTurn: CursorTurnState | undefined;
  stopped: boolean;
  localTurns: CursorLocalTurnSnapshot[];
}

// ── Adapter implementation ────────────────────────────────────────────

export function makeCursorAdapterLive() {
  return Layer.effect(
    CursorAdapter,
    Effect.gen(function* () {
      const services = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(services);
      const serverSettings = yield* ServerSettingsService;
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, CursorSessionContext>();
      let turnCounter = 0;

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(eventQueue, event).pipe(Effect.asVoid);

      const emitRuntimeEvent = (
        context: CursorSessionContext,
        event: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt">,
      ) =>
        emit({
          eventId: eventId(),
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: nowIso(),
          ...event,
        } as ProviderRuntimeEvent);

      // ── Resolve execution target ──────────────────────────────────

      const resolveExecutionTarget = Effect.fn("resolveExecutionTarget")(function* (input: {
        readonly executionBackend: "native" | "wsl";
        readonly wslDistro?: string;
      }): Effect.fn.Return<CursorExecutionTarget, ProviderAdapterValidationError> {
        if (input.executionBackend === "native") {
          return { executionBackend: "native" };
        }
        // WSL: probe for default distro if not given
        if (input.wslDistro) {
          return { executionBackend: "wsl", wslDistro: input.wslDistro };
        }
        const result = yield* Effect.tryPromise({
          try: () =>
            new Promise<string>((resolve, reject) => {
              const proc = spawn("wsl.exe", ["--status"], { env: process.env, shell: false });
              let out = "";
              proc.stdout?.on("data", (chunk: Buffer) => {
                out += chunk.toString();
              });
              proc.stderr?.on("data", (chunk: Buffer) => {
                out += chunk.toString();
              });
              proc.on("close", () => resolve(out));
              proc.on("error", reject);
            }),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "resolveExecutionTarget",
              issue: `Failed to query WSL: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        const distro = parseDefaultWslDistro(result);
        if (!distro) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "resolveExecutionTarget",
            issue: "WSL is installed but no default distro is configured.",
          });
        }
        return { executionBackend: "wsl", wslDistro: distro };
      });

      // ── Session management ────────────────────────────────────────

      const startSession: CursorAdapterShape["startSession"] = Effect.fn("startSession")(
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
          const cursorSettings = settings.providers.cursorAgent;
          const threadId = input.threadId;

          if (sessions.has(threadId)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Session already exists for thread ${threadId}.`,
            });
          }

          const cursor = readCursorResumeCursor(input.resumeCursor);
          const executionTarget = yield* resolveExecutionTarget({
            executionBackend: cursor?.executionBackend ?? cursorSettings.executionBackend,
            ...(cursor?.wslDistro ? { wslDistro: cursor.wslDistro } : {}),
          });
          const adapterKey = buildCursorAdapterKey(executionTarget);
          const cwd = input.cwd ?? cursor?.cwd ?? process.cwd();
          const cursorSessionId = cursor?.sessionId;
          const startedAt = nowIso();

          const resumeCursor: CursorResumeCursor = {
            ...(cursorSessionId ? { sessionId: cursorSessionId } : {}),
            cwd,
            executionBackend: executionTarget.executionBackend,
            ...(executionTarget.wslDistro ? { wslDistro: executionTarget.wslDistro } : {}),
          };

          const session: ProviderSession = {
            threadId,
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(cwd ? { cwd } : {}),
            resumeCursor,
            createdAt: startedAt,
            updatedAt: startedAt,
          };

          const context: CursorSessionContext = {
            session,
            binaryPath: cursorSettings.binaryPath || "cursor-agent",
            executionTarget,
            adapterKey,
            cwd,
            cursorSessionId,
            activeTurn: undefined,
            stopped: false,
            localTurns: [],
          };

          sessions.set(threadId, context);

          yield* emitRuntimeEvent(context, {
            type: "session.started",
            payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
            providerRefs: {},
          });

          yield* emitRuntimeEvent(context, {
            type: "session.state.changed",
            payload: { state: "ready" },
            providerRefs: {},
          });

          return session;
        },
      );

      // ── sendTurn ─────────────────────────────────────────────────

      const sendTurn: CursorAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const threadId = input.threadId;
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
        }
        if (context.activeTurn && !context.activeTurn.completed) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail:
              "A turn is already running. Cursor does not support concurrent turns; use queue-only follow-ups.",
          });
        }

        const prompt = input.input;
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Cursor requires non-empty input text.",
          });
        }

        // Reject image attachments
        if (input.attachments && input.attachments.length > 0) {
          const hasImages = input.attachments.some(
            (a) =>
              "kind" in a &&
              (a.kind === "image" || (typeof a.kind === "string" && a.kind.startsWith("image"))),
          );
          if (hasImages) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: "Cursor does not support image attachments.",
            });
          }
        }

        turnCounter += 1;
        const turnId = TurnId.make(`cursor-turn:${threadId}:${turnCounter}`);
        const updatedAt = nowIso();

        const turnState: CursorTurnState = {
          turnId,
          started: false,
          completed: false,
          streamedAssistantText: "",
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

        yield* emitRuntimeEvent(context, {
          type: "turn.started",
          turnId,
          payload:
            input.modelSelection?.provider === "cursorAgent" && input.modelSelection.model
              ? { model: input.modelSelection.model }
              : {},
          providerRefs: {},
        });

        // Build CLI args
        const model =
          input.modelSelection?.provider === "cursorAgent"
            ? resolveCursorAgentApiModelId({
                model: input.modelSelection.model,
                ...(input.modelSelection.options
                  ? { options: input.modelSelection.options }
                  : { options: undefined }),
              })
            : "auto";
        const cursorArgs = buildCursorTurnArgs({
          prompt,
          model,
          ...(context.cursorSessionId ? { sessionId: context.cursorSessionId } : {}),
          outputFormat: "stream-json",
        });

        const spec = buildCursorSpawnSpec({
          binaryPath: context.binaryPath,
          cursorArgs,
          cwd: context.cwd,
          executionTarget: context.executionTarget,
        });

        // Spawn process
        const childProcess = spawn(spec.command, [...spec.args], {
          env: spec.env,
          cwd: spec.cwd ?? undefined,
          shell: spec.shell,
          stdio: ["ignore", "pipe", "pipe"],
        });
        turnState.process = childProcess;

        const assistantItemId = RuntimeItemId.make(`cursor-item:${threadId}:${turnCounter}:msg`);
        yield* emitRuntimeEvent(context, {
          type: "item.started",
          turnId,
          itemId: assistantItemId,
          payload: { itemType: "assistant_message" },
          providerRefs: {},
        });

        // Stream stdout lines asynchronously via runFork
        runFork(
          Effect.tryPromise({
            try: () =>
              new Promise<void>((resolve, reject) => {
                let buffer = "";
                let stderrBuffer = "";

                childProcess.stdout?.on("data", (chunk: Buffer) => {
                  if (turnState.interrupted) return;
                  buffer += chunk.toString();
                  const lines = buffer.split("\n");
                  buffer = lines.pop() ?? "";
                  for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0) continue;
                    try {
                      const event = JSON.parse(trimmed) as Record<string, unknown>;
                      processStreamEvent(event, context, turnState, assistantItemId);
                    } catch {
                      // Non-JSON line, ignore
                    }
                  }
                });

                childProcess.stderr?.on("data", (chunk: Buffer) => {
                  stderrBuffer += chunk.toString();
                });

                childProcess.on("close", (code) => {
                  // Process remaining buffer
                  if (buffer.trim().length > 0) {
                    try {
                      const event = JSON.parse(buffer.trim()) as Record<string, unknown>;
                      processStreamEvent(event, context, turnState, assistantItemId);
                    } catch {
                      // ignore
                    }
                  }

                  if (turnState.interrupted) {
                    resolve();
                    return;
                  }

                  if (code !== 0 && code !== null) {
                    reject(
                      new Error(
                        `cursor-agent exited with code ${code}. ${stderrBuffer.trim()}`.trim(),
                      ),
                    );
                    return;
                  }

                  resolve();
                });

                childProcess.on("error", (err: Error) => {
                  reject(err);
                });
              }),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: `cursor-agent process error: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          }).pipe(
            Effect.tap(() => finishTurn(context, turnState, "completed")),
            Effect.tapError((error) => {
              if (!turnState.completed) {
                return finishTurn(context, turnState, "failed").pipe(
                  Effect.tap(() =>
                    emitRuntimeEvent(context, {
                      type: "runtime.error",
                      turnId,
                      payload: { message: error.detail },
                      providerRefs: {},
                    }),
                  ),
                );
              }
              return Effect.void;
            }),
            Effect.ignore({ log: true }),
          ),
        );

        return {
          threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

      // ── Stream event processing ──────────────────────────────────

      function processStreamEvent(
        event: Record<string, unknown>,
        context: CursorSessionContext,
        turnState: CursorTurnState,
        assistantItemId: RuntimeItemId,
      ): void {
        const threadId = context.session.threadId;
        const turnId = turnState.turnId;

        // Handle text deltas
        if (event.type === "text_delta" || event.type === "content.delta") {
          const text =
            typeof event.text === "string"
              ? event.text
              : typeof event.delta === "string"
                ? event.delta
                : undefined;
          if (text) {
            turnState.streamedAssistantText += text;
            Effect.runSync(
              emitRuntimeEvent(context, {
                type: "content.delta",
                turnId,
                itemId: assistantItemId,
                payload: { delta: text },
                providerRefs: {},
                raw: {
                  source: "cursor.cli.stream-json",
                  payload: event,
                },
              }),
            );
          }
          return;
        }

        // Handle tool calls
        if (event.type === "tool_call" || event.type === "tool.started") {
          const toolName =
            typeof event.name === "string"
              ? event.name
              : typeof event.tool === "string"
                ? event.tool
                : "unknown_tool";
          const toolItemId = RuntimeItemId.make(
            `cursor-tool:${threadId}:${turnState.turnId}:${toolName}:${Date.now()}`,
          );
          Effect.runSync(
            emitRuntimeEvent(context, {
              type: "item.started",
              turnId,
              itemId: toolItemId,
              payload: {
                itemType: "dynamic_tool_call",
                data: {
                  toolName,
                  ...(typeof event.input === "string" ? { input: event.input } : {}),
                },
              },
              providerRefs: {},
              raw: { source: "cursor.cli.stream-json", payload: event },
            }),
          );
          return;
        }

        // Handle tool results
        if (event.type === "tool_result" || event.type === "tool.completed") {
          const toolName =
            typeof event.name === "string"
              ? event.name
              : typeof event.tool === "string"
                ? event.tool
                : "unknown_tool";
          const toolItemId = RuntimeItemId.make(
            `cursor-tool-result:${threadId}:${turnState.turnId}:${toolName}:${Date.now()}`,
          );
          Effect.runSync(
            emitRuntimeEvent(context, {
              type: "item.completed",
              turnId,
              itemId: toolItemId,
              payload: {
                itemType: "dynamic_tool_call",
                data: {
                  toolName,
                  ...(typeof event.output === "string" ? { output: event.output } : {}),
                },
              },
              providerRefs: {},
              raw: { source: "cursor.cli.stream-json", payload: event },
            }),
          );
          return;
        }

        // Handle session id from Cursor
        if (event.type === "session" || event.type === "session.started") {
          const sid =
            typeof event.session_id === "string"
              ? event.session_id
              : typeof event.sessionId === "string"
                ? event.sessionId
                : undefined;
          if (sid) {
            context.cursorSessionId = sid;
            context.session = {
              ...context.session,
              resumeCursor: {
                ...(typeof context.session.resumeCursor === "object" &&
                context.session.resumeCursor !== null
                  ? (context.session.resumeCursor as Record<string, unknown>)
                  : {}),
                sessionId: sid,
              },
            };
          }
          return;
        }

        // Handle result/completion event
        if (event.type === "result" || event.type === "done") {
          const text =
            typeof event.text === "string"
              ? event.text
              : typeof event.result === "string"
                ? event.result
                : undefined;
          if (text && text.length > 0 && text !== turnState.streamedAssistantText) {
            // Final text may differ from accumulated deltas
            turnState.streamedAssistantText = text;
          }
          return;
        }

        // Handle error events
        if (event.type === "error") {
          const message =
            typeof event.message === "string"
              ? event.message
              : typeof event.error === "string"
                ? event.error
                : "Unknown Cursor error";
          Effect.runSync(
            emitRuntimeEvent(context, {
              type: "runtime.error",
              turnId,
              payload: { message },
              providerRefs: {},
              raw: { source: "cursor.cli.stream-json", payload: event },
            }),
          );
        }
      }

      // ── turn completion ──────────────────────────────────────────

      const finishTurn = Effect.fn("finishTurn")(function* (
        context: CursorSessionContext,
        turnState: CursorTurnState,
        outcome: "completed" | "failed" | "interrupted",
      ) {
        if (turnState.completed) return;
        turnState.completed = true;

        // Persist local turn snapshot
        if (outcome === "completed") {
          context.localTurns.push({
            turnId: turnState.turnId,
            assistantText: turnState.streamedAssistantText,
          });
        }

        if (context.activeTurn === turnState) {
          context.activeTurn = undefined;
        }

        const updatedAt = nowIso();
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

        yield* emitRuntimeEvent(context, {
          type: "turn.completed",
          turnId: turnState.turnId,
          payload: { state },
          providerRefs: {},
        });
      });

      // ── interruptTurn ────────────────────────────────────────────

      const interruptTurn: CursorAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, _turnId) {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }

          const turnState = context.activeTurn;
          if (turnState && !turnState.completed) {
            turnState.interrupted = true;
            // Kill the process tree
            if (turnState.process && !turnState.process.killed) {
              try {
                turnState.process.kill("SIGTERM");
              } catch {
                // Process may have already exited
              }
            }
            yield* finishTurn(context, turnState, "interrupted");
          }
        },
      );

      // ── respondToRequest ─────────────────────────────────────────

      const respondToRequest: CursorAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (_threadId, _requestId, _decision) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail:
            "Cursor headless CLI does not support interactive approval requests. Use full-access runtime mode.",
        });
      });

      // ── respondToUserInput ───────────────────────────────────────

      const respondToUserInput: CursorAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (_threadId, _requestId, _answers) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "Cursor headless CLI does not support interactive user input requests.",
        });
      });

      // ── stopSession ──────────────────────────────────────────────

      const stopSession: CursorAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }

          context.stopped = true;
          if (context.activeTurn && !context.activeTurn.completed) {
            context.activeTurn.interrupted = true;
            if (context.activeTurn.process && !context.activeTurn.process.killed) {
              try {
                context.activeTurn.process.kill("SIGTERM");
              } catch {
                // Process may have already exited
              }
            }
            yield* finishTurn(context, context.activeTurn, "interrupted");
          }

          yield* emitRuntimeEvent(context, {
            type: "session.exited",
            payload: {},
            providerRefs: {},
          });

          sessions.delete(threadId);
        },
      );

      // ── listSessions ────────────────────────────────────────────

      const listSessions: CursorAdapterShape["listSessions"] = () =>
        Effect.succeed(Array.from(sessions.values()).map((context) => context.session));

      // ── hasSession ──────────────────────────────────────────────

      const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
        Effect.succeed(sessions.has(threadId));

      // ── readThread ──────────────────────────────────────────────

      const readThread: CursorAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }

          const turns: ProviderThreadTurnSnapshot[] = context.localTurns.map((snapshot) => ({
            id: snapshot.turnId,
            items: [{ type: "assistant_message", text: snapshot.assistantText }],
          }));

          return { threadId, turns } satisfies ProviderThreadSnapshot;
        },
      );

      // ── rollbackThread ──────────────────────────────────────────

      const rollbackThread: CursorAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = sessions.get(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          }

          // Trim local snapshots
          const trimCount = Math.min(numTurns, context.localTurns.length);
          context.localTurns.splice(context.localTurns.length - trimCount, trimCount);

          // Clear Cursor's session id so next run starts fresh
          context.cursorSessionId = undefined;
          context.session = {
            ...context.session,
            resumeCursor: {
              cwd: context.cwd,
              executionBackend: context.executionTarget.executionBackend,
              ...(context.executionTarget.wslDistro
                ? { wslDistro: context.executionTarget.wslDistro }
                : {}),
            } satisfies CursorResumeCursor,
          };

          const turns: ProviderThreadTurnSnapshot[] = context.localTurns.map((snapshot) => ({
            id: snapshot.turnId,
            items: [{ type: "assistant_message", text: snapshot.assistantText }],
          }));

          return { threadId, turns } satisfies ProviderThreadSnapshot;
        },
      );

      // ── stopAll ─────────────────────────────────────────────────

      const stopAll: CursorAdapterShape["stopAll"] = () =>
        Effect.forEach(
          Array.from(sessions.keys()),
          (threadId) => stopSession(threadId).pipe(Effect.ignore({ log: true })),
          { discard: true },
        );

      // ── streamEvents ────────────────────────────────────────────

      const streamEvents = Stream.fromQueue(eventQueue);

      const capabilities: ProviderAdapterCapabilities = {
        sessionModelSwitch: "in-session",
        busyFollowupMode: "queue-only",
      };

      return {
        provider: PROVIDER,
        capabilities,
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
      } satisfies CursorAdapterShape;
    }),
  );
}
