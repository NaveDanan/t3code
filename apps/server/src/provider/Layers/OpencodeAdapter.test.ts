import type {
  FilePartInput,
  GlobalEvent,
  OpencodeClient,
  Session as OpencodeSdkSession,
  TextPartInput,
} from "@opencode-ai/sdk/v2";
import { ApprovalRequestId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { OpencodeAdapter } from "../Services/OpencodeAdapter.ts";
import {
  OpencodeServerManager,
  type OpencodeConfiguredProvider,
  type OpencodeKnownProvider,
  type OpencodeServerHandle,
  type OpencodeServerManagerShape,
  type OpencodeServerProbe,
} from "../Services/OpencodeServerManager.ts";
import { makeOpencodeAdapterLive } from "./OpencodeAdapter.ts";

const THREAD_ID = ThreadId.make("thread-opencode-1");
const APPROVAL_REQUEST_ID = ApprovalRequestId.make("permission-request-1");
const USER_INPUT_REQUEST_ID = ApprovalRequestId.make("question-request-1");
const opencodeTurnId = (messageId: string) => `opencode-turn:${messageId}`;

const flushAsyncWork = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

class FakeGlobalEventStream implements AsyncIterable<GlobalEvent> {
  private readonly queue: Array<GlobalEvent> = [];
  private readonly waiters: Array<(result: IteratorResult<GlobalEvent>) => void> = [];
  private done = false;

  emit(event: GlobalEvent): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<GlobalEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) {
          return Promise.resolve({ done: false, value: event });
        }
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function makeSdkSession(overrides?: Partial<OpencodeSdkSession>): OpencodeSdkSession {
  return {
    id: "sdk-session-1",
    slug: "session-1",
    projectID: "project-1",
    directory: "D:/repo",
    title: "OpenCode Session",
    version: "1.3.15",
    time: {
      created: 1,
      updated: 1,
    },
    ...overrides,
  };
}

function makeProbe(server: OpencodeServerHandle): OpencodeServerProbe {
  return {
    server,
    configuredProviders: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5": {
            id: "gpt-5",
            name: "GPT-5",
            limit: {
              context: 100,
              output: 20,
            },
          },
        },
      } as unknown as OpencodeConfiguredProvider,
    ],
    knownProviders: [
      {
        id: "openai",
        name: "OpenAI",
      } as unknown as OpencodeKnownProvider,
    ],
    connectedProviderIds: ["openai"],
    authMethodsByProviderId: {
      openai: [{ type: "api", label: "API key" }],
    },
    defaultModelByProviderId: {
      openai: "gpt-5",
    },
  };
}

function makeMessageEntry(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly created: number;
  readonly parentID?: string;
}) {
  if (input.role === "user") {
    return {
      info: {
        id: input.id,
        sessionID: "sdk-session-1",
        role: "user",
        time: {
          created: input.created,
        },
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
      },
      parts: [],
    } as never;
  }

  return {
    info: {
      id: input.id,
      sessionID: "sdk-session-1",
      role: "assistant",
      time: {
        created: input.created,
        completed: input.created + 1,
      },
      parentID: input.parentID ?? "user-message-1",
      modelID: "gpt-5",
      providerID: "openai",
      mode: "default",
      agent: "build",
      path: {
        cwd: "D:/repo",
        root: "D:/repo",
      },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
    },
    parts: [],
  } as never;
}

function makeHarness() {
  const eventStream = new FakeGlobalEventStream();
  const sdkSession = makeSdkSession();
  let createSessionInput: { directory: string } | undefined;
  let promptAsyncInput:
    | {
        sessionID: string;
        directory: string;
        messageID?: string;
        model?: {
          providerID: string;
          modelID: string;
        };
        variant?: string;
        parts: Array<TextPartInput | FilePartInput>;
      }
    | undefined;
  let summarizeInput:
    | {
        sessionID: string;
        directory?: string;
        providerID: string;
        modelID: string;
        auto?: boolean;
      }
    | undefined;

  const createSession = vi.fn(async (input: { directory: string }) => {
    createSessionInput = input;
    return { data: sdkSession };
  });
  const getSession = vi.fn(async (_input: { sessionID: string; directory?: string }) => ({
    data: sdkSession,
  }));
  const promptAsync = vi.fn(
    async (input: {
      sessionID: string;
      directory: string;
      messageID?: string;
      model?: {
        providerID: string;
        modelID: string;
      };
      variant?: string;
      parts: Array<TextPartInput | FilePartInput>;
    }) => {
      promptAsyncInput = input;
      return { response: { status: 204 } as Response };
    },
  );
  const abortSession = vi.fn(async (_input: { sessionID: string; directory: string }) => ({
    data: true,
  }));
  const summarizeSession = vi.fn(
    async (input: {
      sessionID: string;
      directory?: string;
      providerID: string;
      modelID: string;
      auto?: boolean;
    }) => {
      summarizeInput = input;
      return { data: true };
    },
  );
  const listMessages = vi.fn(
    async (_input: { sessionID: string; directory: string; limit: number }) => ({ data: [] }),
  );
  const revertSession = vi.fn(
    async (_input: { sessionID: string; directory: string; messageID: string }) => ({
      data: sdkSession,
    }),
  );
  const permissionReply = vi.fn(
    async (_input: {
      requestID: string;
      directory: string;
      reply: "once" | "always" | "reject";
    }) => ({
      data: true,
    }),
  );
  const questionReply = vi.fn(
    async (_input: { requestID: string; directory: string; answers: Array<Array<string>> }) => ({
      data: true,
    }),
  );
  const questionReject = vi.fn(async (_input: { requestID: string; directory: string }) => ({
    data: true,
  }));

  const client = {
    session: {
      create: createSession,
      get: getSession,
      promptAsync,
      summarize: summarizeSession,
      abort: abortSession,
      messages: listMessages,
      revert: revertSession,
    },
    permission: {
      reply: permissionReply,
    },
    question: {
      reply: questionReply,
      reject: questionReject,
    },
  } as unknown as OpencodeClient;

  const server: OpencodeServerHandle = {
    binaryPath: "opencode",
    url: "http://127.0.0.1:4196",
    client,
    version: "1.3.15",
  };
  const probe = makeProbe(server);

  const manager: OpencodeServerManagerShape = {
    ensureServer: () => Effect.succeed(server),
    probe: () => Effect.succeed(probe),
    streamEvents: () =>
      Stream.fromAsyncIterable(eventStream, (cause): never => {
        throw cause instanceof Error ? cause : new Error(String(cause));
      }),
    stop: Effect.sync(() => {
      eventStream.finish();
    }),
  };

  return {
    eventStream,
    inputs: {
      get createSession() {
        return createSessionInput;
      },
      get promptAsync() {
        return promptAsyncInput;
      },
      get summarize() {
        return summarizeInput;
      },
    },
    mocks: {
      createSession,
      getSession,
      promptAsync,
      summarizeSession,
      abortSession,
      listMessages,
      revertSession,
      permissionReply,
      questionReply,
      questionReject,
    },
    layer: makeOpencodeAdapterLive().pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(Layer.succeed(OpencodeServerManager, manager)),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}

describe("OpencodeAdapterLive", () => {
  it.effect("returns validation error for non-opencode provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: "codex",
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "opencode",
          operation: "startSession",
          issue: "Expected provider 'opencode' but received 'codex'.",
        }),
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("starts a turn with a provider-native ascending msg_ messageID", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: {
            effort: "high",
          },
        },
      });

      assert.deepEqual(harness.inputs.createSession, {
        directory: "D:/repo",
      });

      const promptInput = harness.inputs.promptAsync;
      assert.equal(promptInput?.sessionID, "sdk-session-1");
      assert.equal(promptInput?.directory, "D:/repo");
      assert.equal(typeof promptInput?.messageID, "string");
      assert.equal(promptInput?.messageID?.startsWith("msg_"), true);
      assert.equal((promptInput?.messageID ?? "") > "msg_00000000000000000000000000", true);
      assert.notEqual(promptInput?.messageID, turn.turnId);
      assert.deepEqual(promptInput?.model, {
        providerID: "openai",
        modelID: "gpt-5",
      });
      assert.equal(promptInput?.variant, "high");
      assert.deepEqual(promptInput?.parts, [
        {
          type: "text",
          text: "hello",
        },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("emits an initial OpenCode context window snapshot for the active model", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      try {
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "opencode",
          cwd: "D:/repo",
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5",
          },
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        yield* flushAsyncWork;

        const initialUsageEvent = runtimeEvents.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
            event.type === "thread.token-usage.updated",
        );
        assert.equal(initialUsageEvent?.type, "thread.token-usage.updated");
        if (initialUsageEvent?.type !== "thread.token-usage.updated") {
          return;
        }

        assert.equal(initialUsageEvent.payload.usage.usedTokens, 0);
        assert.equal(initialUsageEvent.payload.usage.totalProcessedTokens, 0);
        assert.equal(initialUsageEvent.payload.usage.maxTokens, 100);
        assert.equal(initialUsageEvent.payload.usage.compactsAutomatically, true);
      } finally {
        yield* Fiber.interrupt(runtimeEventsFiber);
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("emits live OpenCode token usage snapshots with context window metadata", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      try {
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "opencode",
          cwd: "D:/repo",
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5",
          },
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        const providerUserMessageId = harness.inputs.promptAsync?.messageID;
        assert.equal(typeof providerUserMessageId, "string");
        if (!providerUserMessageId) {
          return;
        }

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: "assistant-message-usage-live",
                sessionID: "sdk-session-1",
                role: "assistant",
                time: {
                  created: 2,
                },
                parentID: providerUserMessageId,
                modelID: "gpt-5",
                providerID: "openai",
                mode: "default",
                agent: "build",
                path: {
                  cwd: "D:/repo",
                  root: "D:/repo",
                },
                cost: 0,
                tokens: {
                  total: 24,
                  input: 18,
                  output: 6,
                  reasoning: 0,
                  cache: {
                    read: 0,
                    write: 0,
                  },
                },
              },
            },
          },
        } as GlobalEvent);

        yield* flushAsyncWork;
        yield* flushAsyncWork;

        const usageEvents = runtimeEvents.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
            event.type === "thread.token-usage.updated",
        );
        const latestUsageEvent = usageEvents.at(-1);
        assert.equal(latestUsageEvent?.type, "thread.token-usage.updated");
        if (latestUsageEvent?.type !== "thread.token-usage.updated") {
          return;
        }

        assert.equal(latestUsageEvent.payload.usage.usedTokens, 24);
        assert.equal(latestUsageEvent.payload.usage.maxTokens, 100);
        assert.equal(latestUsageEvent.payload.usage.compactsAutomatically, true);
      } finally {
        yield* Fiber.interrupt(runtimeEventsFiber);
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "does not reset OpenCode live context usage when a later assistant message starts at zero",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkChild);

        try {
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "opencode",
            cwd: "D:/repo",
            modelSelection: {
              provider: "opencode",
              model: "openai/gpt-5",
            },
            runtimeMode: "full-access",
          });

          yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "hello",
            attachments: [],
          });

          const providerUserMessageId = harness.inputs.promptAsync?.messageID;
          assert.equal(typeof providerUserMessageId, "string");
          if (!providerUserMessageId) {
            return;
          }

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-before-tool",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: 2,
                  },
                  parentID: providerUserMessageId,
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 24,
                    input: 18,
                    output: 6,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-after-tool",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: 3,
                  },
                  parentID: providerUserMessageId,
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 0,
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;
          yield* flushAsyncWork;

          const latestUsageEvent = runtimeEvents.findLast(
            (
              event,
            ): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
              event.type === "thread.token-usage.updated",
          );
          assert.equal(latestUsageEvent?.type, "thread.token-usage.updated");
          if (latestUsageEvent?.type !== "thread.token-usage.updated") {
            return;
          }

          assert.equal(latestUsageEvent.payload.usage.usedTokens, 24);
          assert.equal(latestUsageEvent.payload.usage.maxTokens, 100);
        } finally {
          yield* Fiber.interrupt(runtimeEventsFiber);
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "emits OpenCode token usage snapshots with context window metadata on completion",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkChild);

        try {
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "opencode",
            cwd: "D:/repo",
            modelSelection: {
              provider: "opencode",
              model: "openai/gpt-5",
            },
            runtimeMode: "full-access",
          });

          yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "hello",
            attachments: [],
          });

          const providerUserMessageId = harness.inputs.promptAsync?.messageID;
          assert.equal(typeof providerUserMessageId, "string");
          if (!providerUserMessageId) {
            return;
          }

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-usage",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: 2,
                    completed: 3,
                  },
                  parentID: providerUserMessageId,
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 50,
                    input: 35,
                    output: 15,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
                status: {
                  type: "idle",
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;
          yield* flushAsyncWork;

          const usageEvent = runtimeEvents.findLast(
            (
              event,
            ): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
              event.type === "thread.token-usage.updated",
          );
          assert.equal(usageEvent?.type, "thread.token-usage.updated");
          if (usageEvent?.type !== "thread.token-usage.updated") {
            return;
          }

          assert.equal(usageEvent.payload.usage.usedTokens, 50);
          assert.equal(usageEvent.payload.usage.maxTokens, 100);
          assert.equal(usageEvent.payload.usage.compactsAutomatically, true);
        } finally {
          yield* Fiber.interrupt(runtimeEventsFiber);
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("auto-compacts before a new turn when usage reaches 85 percent of context", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
        },
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first turn",
        attachments: [],
      });

      const firstProviderUserMessageId = harness.inputs.promptAsync?.messageID;
      assert.equal(typeof firstProviderUserMessageId, "string");
      if (!firstProviderUserMessageId) {
        return;
      }

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "sdk-session-1",
            info: {
              id: "assistant-message-first",
              sessionID: "sdk-session-1",
              role: "assistant",
              time: {
                created: 2,
                completed: 3,
              },
              parentID: firstProviderUserMessageId,
              modelID: "gpt-5",
              providerID: "openai",
              mode: "default",
              agent: "build",
              path: {
                cwd: "D:/repo",
                root: "D:/repo",
              },
              cost: 0,
              tokens: {
                total: 90,
                input: 70,
                output: 20,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
            },
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "session.idle",
          properties: {
            sessionID: "sdk-session-1",
            status: {
              type: "idle",
            },
          },
        },
      } as GlobalEvent);

      yield* flushAsyncWork;
      yield* flushAsyncWork;

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "second turn",
        attachments: [],
      });

      assert.equal(harness.mocks.summarizeSession.mock.calls.length, 1);
      assert.deepEqual(harness.inputs.summarize, {
        sessionID: "sdk-session-1",
        directory: "D:/repo",
        providerID: "openai",
        modelID: "gpt-5",
        auto: false,
      });
      assert.equal(harness.mocks.promptAsync.mock.calls.length, 2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "maps assistant parentIDs back to the original T3 turn when OpenCode uses provider message IDs",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "opencode",
          cwd: "D:/repo",
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        const providerUserMessageId = harness.inputs.promptAsync?.messageID;
        assert.equal(typeof providerUserMessageId, "string");
        if (!providerUserMessageId) {
          return;
        }

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: providerUserMessageId,
                sessionID: "sdk-session-1",
                role: "user",
                time: {
                  created: 1,
                },
                agent: "build",
                model: {
                  providerID: "openai",
                  modelID: "gpt-5",
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: "assistant-message-1",
                sessionID: "sdk-session-1",
                role: "assistant",
                time: {
                  created: 2,
                  completed: 3,
                },
                parentID: providerUserMessageId,
                modelID: "gpt-5",
                providerID: "openai",
                mode: "default",
                agent: "build",
                path: {
                  cwd: "D:/repo",
                  root: "D:/repo",
                },
                cost: 0,
                tokens: {
                  total: 2,
                  input: 1,
                  output: 1,
                  reasoning: 0,
                  cache: {
                    read: 0,
                    write: 0,
                  },
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "session.idle",
            properties: {
              sessionID: "sdk-session-1",
              status: {
                type: "idle",
              },
            },
          },
        } as GlobalEvent);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const startedTurns = runtimeEvents.filter(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.started" }> =>
            event.type === "turn.started",
        );
        const completedTurn = runtimeEvents.find(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
            event.type === "turn.completed",
        );
        const firstStartedTurn = startedTurns[0];

        assert.equal(startedTurns.length, 1);
        assert.isDefined(firstStartedTurn);
        if (!firstStartedTurn) {
          return;
        }
        assert.equal(firstStartedTurn.turnId, turn.turnId);
        assert.equal(completedTurn?.turnId, turn.turnId);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "completes a turn after current-turn activity even when OpenCode rewrites the assistant parent ID",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const nowMs = 1_700_000_000_000;
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);

        try {
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "opencode",
            cwd: "D:/repo",
            runtimeMode: "full-access",
          });

          const firstTurn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "hello",
            attachments: [],
          });

          const providerUserMessageId = harness.inputs.promptAsync?.messageID;
          assert.equal(typeof providerUserMessageId, "string");
          if (!providerUserMessageId) {
            return;
          }

          harness.mocks.listMessages.mockResolvedValue({
            data: [
              makeMessageEntry({
                id: "server-user-message-1",
                role: "user",
                created: nowMs + 5,
              }),
            ],
          });

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: providerUserMessageId,
                  sessionID: "sdk-session-1",
                  role: "user",
                  time: {
                    created: nowMs + 5,
                  },
                  agent: "build",
                  model: {
                    providerID: "openai",
                    modelID: "gpt-5",
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-1",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: nowMs + 10,
                    completed: nowMs + 20,
                  },
                  parentID: "server-user-message-1",
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 2,
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;
          yield* flushAsyncWork;
          yield* flushAsyncWork;
          yield* flushAsyncWork;
          yield* flushAsyncWork;

          const sessionsAfterFirstTurn = yield* adapter.listSessions();
          const sessionAfterFirstTurn = sessionsAfterFirstTurn[0];

          assert.isDefined(sessionAfterFirstTurn);
          assert.equal(sessionAfterFirstTurn?.status, "running");
          assert.equal(sessionAfterFirstTurn?.activeTurnId, firstTurn.turnId);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
                status: {
                  type: "idle",
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;

          const sessionsAfterIdle = yield* adapter.listSessions();
          const sessionAfterIdle = sessionsAfterIdle[0];

          assert.isDefined(sessionAfterIdle);
          assert.equal(sessionAfterIdle?.status, "ready");
          assert.equal(sessionAfterIdle?.activeTurnId, undefined);

          const secondTurn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "second turn",
            attachments: [],
          });

          assert.notEqual(secondTurn.turnId, firstTurn.turnId);
          assert.equal(harness.mocks.promptAsync.mock.calls.length, 2);
        } finally {
          dateNowSpy.mockRestore();
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "ignores replayed prior-turn assistant history and completes a second turn with a rewritten parent ID",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const nowMs = 1_700_000_000_000;
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);

        try {
          const runtimeEvents: Array<ProviderRuntimeEvent> = [];
          const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "opencode",
            cwd: "D:/repo",
            runtimeMode: "full-access",
          });

          const firstTurn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "first turn",
            attachments: [],
          });

          const firstProviderUserMessageId = harness.inputs.promptAsync?.messageID;
          assert.equal(typeof firstProviderUserMessageId, "string");
          if (!firstProviderUserMessageId) {
            return;
          }

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-1",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: nowMs + 10,
                    completed: nowMs + 20,
                  },
                  parentID: firstProviderUserMessageId,
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 2,
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
                status: {
                  type: "idle",
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;

          const secondTurnNowMs = nowMs + 1_000;

          dateNowSpy.mockReturnValue(secondTurnNowMs);

          const secondTurn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "second turn",
            attachments: [],
          });

          const secondProviderUserMessageId = harness.inputs.promptAsync?.messageID;
          assert.equal(typeof secondProviderUserMessageId, "string");
          if (!secondProviderUserMessageId) {
            return;
          }

          harness.mocks.listMessages.mockResolvedValue({
            data: [
              makeMessageEntry({
                id: "server-user-message-2",
                role: "user",
                created: secondTurnNowMs + 5,
              }),
              makeMessageEntry({
                id: "assistant-message-1",
                role: "assistant",
                parentID: firstProviderUserMessageId,
                created: secondTurnNowMs + 6,
              }),
            ],
          });

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-1",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: secondTurnNowMs + 10,
                    completed: secondTurnNowMs + 11,
                  },
                  parentID: firstProviderUserMessageId,
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 2,
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.part.updated",
              properties: {
                sessionID: "sdk-session-1",
                part: {
                  id: "part-text-1",
                  sessionID: "sdk-session-1",
                  messageID: "assistant-message-2",
                  type: "text",
                  text: "second turn response",
                  time: {
                    start: secondTurnNowMs + 12,
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-2",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: secondTurnNowMs + 12,
                    completed: secondTurnNowMs + 20,
                  },
                  parentID: "server-user-message-2",
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 4,
                    input: 2,
                    output: 2,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
                status: {
                  type: "idle",
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;
          yield* flushAsyncWork;
          yield* Fiber.interrupt(runtimeEventsFiber);

          const completedTurns = runtimeEvents.filter(
            (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
              event.type === "turn.completed",
          );
          const assistantDeltas = runtimeEvents.filter(
            (event): event is Extract<(typeof runtimeEvents)[number], { type: "content.delta" }> =>
              event.type === "content.delta" && event.payload.streamKind === "assistant_text",
          );

          assert.deepEqual(
            completedTurns.map((event) => event.turnId),
            [firstTurn.turnId, secondTurn.turnId],
          );
          assert.deepEqual(
            assistantDeltas.map((event) => [event.itemId, event.payload.delta]),
            [["assistant-message-2", "second turn response"]],
          );
        } finally {
          dateNowSpy.mockRestore();
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "ignores a stray immediate session.idle on a new turn until current-turn activity arrives",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const nowMs = 1_700_000_000_000;
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);

        try {
          const runtimeEvents: Array<ProviderRuntimeEvent> = [];
          const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ).pipe(Effect.forkChild);

          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "opencode",
            cwd: "D:/repo",
            runtimeMode: "full-access",
          });

          const firstTurn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "first turn",
            attachments: [],
          });

          const firstProviderUserMessageId = harness.inputs.promptAsync?.messageID;
          assert.equal(typeof firstProviderUserMessageId, "string");
          if (!firstProviderUserMessageId) {
            return;
          }

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-1",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: nowMs + 10,
                    completed: nowMs + 20,
                  },
                  parentID: firstProviderUserMessageId,
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 2,
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
                status: {
                  type: "idle",
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;

          const secondTurnNowMs = nowMs + 1_000;
          dateNowSpy.mockReturnValue(secondTurnNowMs);

          const secondTurn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "second turn",
            attachments: [],
          });

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
                status: {
                  type: "idle",
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;

          const sessionsAfterStrayIdle = yield* adapter.listSessions();
          const sessionAfterStrayIdle = sessionsAfterStrayIdle[0];

          assert.isDefined(sessionAfterStrayIdle);
          assert.equal(sessionAfterStrayIdle?.status, "running");
          assert.equal(sessionAfterStrayIdle?.activeTurnId, secondTurn.turnId);

          const completedTurnsAfterStrayIdle = runtimeEvents.filter(
            (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
              event.type === "turn.completed",
          );
          assert.deepEqual(
            completedTurnsAfterStrayIdle.map((event) => event.turnId),
            [firstTurn.turnId],
          );

          const secondProviderUserMessageId = harness.inputs.promptAsync?.messageID;
          assert.equal(typeof secondProviderUserMessageId, "string");
          if (!secondProviderUserMessageId) {
            return;
          }

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.updated",
              properties: {
                sessionID: "sdk-session-1",
                info: {
                  id: "assistant-message-2",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                  time: {
                    created: secondTurnNowMs + 10,
                    completed: secondTurnNowMs + 20,
                  },
                  parentID: secondProviderUserMessageId,
                  modelID: "gpt-5",
                  providerID: "openai",
                  mode: "default",
                  agent: "build",
                  path: {
                    cwd: "D:/repo",
                    root: "D:/repo",
                  },
                  cost: 0,
                  tokens: {
                    total: 2,
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: {
                      read: 0,
                      write: 0,
                    },
                  },
                },
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "message.part.delta",
              properties: {
                sessionID: "sdk-session-1",
                messageID: "assistant-message-2",
                partID: "assistant-text-part-2",
                delta: "TURN_TWO",
              },
            },
          } as GlobalEvent);

          harness.eventStream.emit({
            directory: "D:/repo",
            payload: {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
                status: {
                  type: "idle",
                },
              },
            },
          } as GlobalEvent);

          yield* flushAsyncWork;
          yield* flushAsyncWork;
          yield* Fiber.interrupt(runtimeEventsFiber);

          const completedTurns = runtimeEvents.filter(
            (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
              event.type === "turn.completed",
          );
          const assistantDeltas = runtimeEvents.filter(
            (event): event is Extract<(typeof runtimeEvents)[number], { type: "content.delta" }> =>
              event.type === "content.delta" && event.payload.streamKind === "assistant_text",
          );

          assert.deepEqual(
            completedTurns.map((event) => event.turnId),
            [firstTurn.turnId, secondTurn.turnId],
          );
          assert.deepEqual(
            assistantDeltas.map((event) => [event.itemId, event.payload.delta]),
            [["assistant-message-2", "TURN_TWO"]],
          );
        } finally {
          dateNowSpy.mockRestore();
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "does not let an echoed current user message complete a second turn before assistant activity starts",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "opencode",
          cwd: "D:/repo",
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "first turn",
          attachments: [],
        });

        const firstProviderUserMessageId = harness.inputs.promptAsync?.messageID;
        assert.equal(typeof firstProviderUserMessageId, "string");
        if (!firstProviderUserMessageId) {
          return;
        }

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: "assistant-message-1",
                sessionID: "sdk-session-1",
                role: "assistant",
                time: {
                  created: 2,
                  completed: 3,
                },
                parentID: firstProviderUserMessageId,
                modelID: "gpt-5",
                providerID: "openai",
                mode: "default",
                agent: "build",
                path: {
                  cwd: "D:/repo",
                  root: "D:/repo",
                },
                cost: 0,
                tokens: {
                  total: 2,
                  input: 1,
                  output: 1,
                  reasoning: 0,
                  cache: {
                    read: 0,
                    write: 0,
                  },
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "session.idle",
            properties: {
              sessionID: "sdk-session-1",
              status: {
                type: "idle",
              },
            },
          },
        } as GlobalEvent);

        yield* flushAsyncWork;

        const secondTurn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "second turn",
          attachments: [],
        });

        const secondProviderUserMessageId = harness.inputs.promptAsync?.messageID;
        assert.equal(typeof secondProviderUserMessageId, "string");
        if (!secondProviderUserMessageId) {
          return;
        }

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: secondProviderUserMessageId,
                sessionID: "sdk-session-1",
                role: "user",
                time: {
                  created: 4,
                },
                agent: "build",
                model: {
                  providerID: "openai",
                  modelID: "gpt-5",
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.part.updated",
            properties: {
              sessionID: "sdk-session-1",
              part: {
                id: "user-text-part-2",
                sessionID: "sdk-session-1",
                messageID: secondProviderUserMessageId,
                type: "text",
                text: "echoed user text",
                time: {
                  start: 5,
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "session.idle",
            properties: {
              sessionID: "sdk-session-1",
              status: {
                type: "idle",
              },
            },
          },
        } as GlobalEvent);

        yield* flushAsyncWork;

        const sessionsAfterEchoedUserIdle = yield* adapter.listSessions();
        const sessionAfterEchoedUserIdle = sessionsAfterEchoedUserIdle[0];

        assert.isDefined(sessionAfterEchoedUserIdle);
        assert.equal(sessionAfterEchoedUserIdle?.status, "running");
        assert.equal(sessionAfterEchoedUserIdle?.activeTurnId, secondTurn.turnId);

        const completedTurnsAfterEchoedUserIdle = runtimeEvents.filter(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
            event.type === "turn.completed",
        );
        assert.deepEqual(
          completedTurnsAfterEchoedUserIdle.map((event) => event.turnId),
          [firstTurn.turnId],
        );

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: "assistant-message-2",
                sessionID: "sdk-session-1",
                role: "assistant",
                time: {
                  created: 6,
                  completed: 7,
                },
                parentID: secondProviderUserMessageId,
                modelID: "gpt-5",
                providerID: "openai",
                mode: "default",
                agent: "build",
                path: {
                  cwd: "D:/repo",
                  root: "D:/repo",
                },
                cost: 0,
                tokens: {
                  total: 2,
                  input: 1,
                  output: 1,
                  reasoning: 0,
                  cache: {
                    read: 0,
                    write: 0,
                  },
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.part.updated",
            properties: {
              sessionID: "sdk-session-1",
              part: {
                id: "assistant-text-part-2",
                sessionID: "sdk-session-1",
                messageID: "assistant-message-2",
                type: "text",
                text: "assistant text",
                time: {
                  start: 6,
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "session.idle",
            properties: {
              sessionID: "sdk-session-1",
              status: {
                type: "idle",
              },
            },
          },
        } as GlobalEvent);

        yield* flushAsyncWork;
        yield* flushAsyncWork;
        yield* Fiber.interrupt(runtimeEventsFiber);

        const completedTurns = runtimeEvents.filter(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
            event.type === "turn.completed",
        );
        const assistantDeltas = runtimeEvents.filter(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "content.delta" }> =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        );

        assert.deepEqual(
          completedTurns.map((event) => event.turnId),
          [firstTurn.turnId, secondTurn.turnId],
        );
        assert.deepEqual(
          assistantDeltas.map((event) => [event.itemId, event.payload.delta]),
          [["assistant-message-2", "assistant text"]],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("classifies cached reasoning deltas as reasoning_text runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID: "sdk-session-1",
            part: {
              id: "reasoning-part-1",
              sessionID: "sdk-session-1",
              messageID: "assistant-message-1",
              type: "reasoning",
              text: "",
              time: {
                start: 1,
              },
            },
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "sdk-session-1",
            messageID: "assistant-message-1",
            partID: "reasoning-part-1",
            field: "text",
            delta: "thinking",
          },
        },
      } as GlobalEvent);

      try {
        yield* flushAsyncWork;
        yield* flushAsyncWork;

        const reasoningDelta = runtimeEvents.findLast(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && event.itemId === "reasoning-part-1",
        );

        assert.isDefined(reasoningDelta);
        assert.equal(reasoningDelta?.type, "content.delta");
        if (!reasoningDelta || reasoningDelta.type !== "content.delta") {
          return;
        }

        assert.equal(reasoningDelta.turnId, turn.turnId);
        assert.equal(reasoningDelta.itemId, "reasoning-part-1");
        assert.equal(reasoningDelta.payload.streamKind, "reasoning_text");
        assert.equal(reasoningDelta.payload.delta, "thinking");
      } finally {
        yield* Fiber.interrupt(runtimeEventsFiber);
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores user text-part replay so prompts are not echoed as assistant output", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "what model are you and when is your knowledge cutoff?",
        attachments: [],
      });

      const providerUserMessageId = harness.inputs.promptAsync?.messageID;
      assert.equal(typeof providerUserMessageId, "string");
      if (!providerUserMessageId) {
        return;
      }

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "sdk-session-1",
            info: {
              id: providerUserMessageId,
              sessionID: "sdk-session-1",
              role: "user",
              time: {
                created: 1,
              },
              agent: "build",
              model: {
                providerID: "openai",
                modelID: "gpt-5",
              },
            },
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID: "sdk-session-1",
            part: {
              id: "user-text-part-1",
              sessionID: "sdk-session-1",
              messageID: providerUserMessageId,
              type: "text",
              text: "what model are you and when is your knowledge cutoff?",
              time: {
                start: 1,
              },
            },
            time: 1,
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "sdk-session-1",
            messageID: providerUserMessageId,
            partID: "user-text-part-1",
            field: "text",
            delta: "what model are you and when is your knowledge cutoff?",
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "session.idle",
          properties: {
            sessionID: "sdk-session-1",
            status: {
              type: "idle",
            },
          },
        },
      } as GlobalEvent);

      yield* flushAsyncWork;
      yield* flushAsyncWork;

      const sessions = yield* adapter.listSessions();
      const session = sessions[0];
      const assistantEchoEvents = runtimeEvents.filter(
        (event) =>
          (event.type === "item.started" && event.payload.itemType === "assistant_message") ||
          (event.type === "content.delta" && event.payload.streamKind === "assistant_text") ||
          (event.type === "item.completed" && event.payload.itemType === "assistant_message"),
      );
      const completedTurn = runtimeEvents.find(
        (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.isDefined(session);
      assert.equal(session?.status, "running");
      assert.equal(session?.activeTurnId, turn.turnId);
      assert.equal(assistantEchoEvents.length, 0);
      assert.equal(completedTurn, undefined);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the turn running across multiple assistant messages until session.idle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "edit the file and then keep going",
        attachments: [],
      });

      const providerUserMessageId = harness.inputs.promptAsync?.messageID;
      assert.equal(typeof providerUserMessageId, "string");
      if (!providerUserMessageId) {
        return;
      }

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "sdk-session-1",
            info: {
              id: providerUserMessageId,
              sessionID: "sdk-session-1",
              role: "user",
              time: {
                created: 1,
              },
              agent: "build",
              model: {
                providerID: "openai",
                modelID: "gpt-5",
              },
            },
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "sdk-session-1",
            info: {
              id: "assistant-message-1",
              sessionID: "sdk-session-1",
              role: "assistant",
              time: {
                created: 2,
                completed: 3,
              },
              parentID: providerUserMessageId,
              modelID: "gpt-5",
              providerID: "openai",
              mode: "default",
              agent: "build",
              path: {
                cwd: "D:/repo",
                root: "D:/repo",
              },
              cost: 0.1,
              tokens: {
                total: 2,
                input: 1,
                output: 1,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
            },
          },
        },
      } as GlobalEvent);

      yield* flushAsyncWork;

      const sessionsAfterFirstAssistant = yield* adapter.listSessions();
      const sessionAfterFirstAssistant = sessionsAfterFirstAssistant[0];

      assert.isDefined(sessionAfterFirstAssistant);
      assert.equal(sessionAfterFirstAssistant?.status, "running");
      assert.equal(sessionAfterFirstAssistant?.activeTurnId, turn.turnId);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "sdk-session-1",
            messageID: "assistant-message-2",
            partID: "assistant-text-part-2",
            delta: "Still working on the same turn",
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "sdk-session-1",
            info: {
              id: "assistant-message-2",
              sessionID: "sdk-session-1",
              role: "assistant",
              time: {
                created: 4,
                completed: 5,
              },
              parentID: providerUserMessageId,
              modelID: "gpt-5",
              providerID: "openai",
              mode: "default",
              agent: "build",
              path: {
                cwd: "D:/repo",
                root: "D:/repo",
              },
              cost: 0.2,
              tokens: {
                total: 4,
                input: 2,
                output: 2,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
            },
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "session.idle",
          properties: {
            sessionID: "sdk-session-1",
            status: {
              type: "idle",
            },
          },
        },
      } as GlobalEvent);

      try {
        yield* flushAsyncWork;
        yield* flushAsyncWork;

        const completedAssistantItems = runtimeEvents.filter(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "item.completed" }> =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        );
        const secondAssistantDelta = runtimeEvents.find(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "content.delta" }> =>
            event.type === "content.delta" && event.itemId === "assistant-message-2",
        );
        const completedTurn = runtimeEvents.findLast(
          (event): event is Extract<(typeof runtimeEvents)[number], { type: "turn.completed" }> =>
            event.type === "turn.completed",
        );

        assert.deepEqual(
          completedAssistantItems.map((event) => String(event.itemId)),
          ["assistant-message-1", "assistant-message-2"],
        );
        assert.equal(secondAssistantDelta?.payload.delta, "Still working on the same turn");
        assert.equal(completedTurn?.turnId, turn.turnId);

        const sessionsAfterIdle = yield* adapter.listSessions();
        const sessionAfterIdle = sessionsAfterIdle[0];

        assert.isDefined(sessionAfterIdle);
        assert.equal(sessionAfterIdle?.status, "ready");
        assert.equal(sessionAfterIdle?.activeTurnId, undefined);
      } finally {
        yield* Fiber.interrupt(runtimeEventsFiber);
      }
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "does not re-enter running when OpenCode emits busy after a turn already completed",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpencodeAdapter;

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "opencode",
          cwd: "D:/repo",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        const providerUserMessageId = harness.inputs.promptAsync?.messageID;
        assert.equal(typeof providerUserMessageId, "string");
        if (!providerUserMessageId) {
          return;
        }

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: providerUserMessageId,
                sessionID: "sdk-session-1",
                role: "user",
                time: {
                  created: 1,
                },
                agent: "build",
                model: {
                  providerID: "openai",
                  modelID: "gpt-5",
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "sdk-session-1",
              info: {
                id: "assistant-message-1",
                sessionID: "sdk-session-1",
                role: "assistant",
                time: {
                  created: 2,
                  completed: 3,
                },
                parentID: providerUserMessageId,
                modelID: "gpt-5",
                providerID: "openai",
                mode: "default",
                agent: "build",
                path: {
                  cwd: "D:/repo",
                  root: "D:/repo",
                },
                cost: 0,
                tokens: {
                  total: 2,
                  input: 1,
                  output: 1,
                  reasoning: 0,
                  cache: {
                    read: 0,
                    write: 0,
                  },
                },
              },
            },
          },
        } as GlobalEvent);

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "session.idle",
            properties: {
              sessionID: "sdk-session-1",
              status: {
                type: "idle",
              },
            },
          },
        } as GlobalEvent);

        yield* flushAsyncWork;

        harness.eventStream.emit({
          directory: "D:/repo",
          payload: {
            type: "session.status",
            properties: {
              sessionID: "sdk-session-1",
              status: {
                type: "busy",
              },
            },
          },
        } as GlobalEvent);

        yield* flushAsyncWork;

        const sessions = yield* adapter.listSessions();
        const session = sessions[0];

        assert.isDefined(session);
        assert.equal(session?.status, "ready");
        assert.equal(session?.activeTurnId, undefined);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("resumes an existing OpenCode session from the persisted resume cursor", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        resumeCursor: {
          sessionId: "sdk-session-1",
          cwd: "D:/resume-repo",
        },
        runtimeMode: "full-access",
      });

      assert.equal(harness.mocks.createSession.mock.calls.length, 0);
      assert.deepEqual(harness.mocks.getSession.mock.calls[0]?.[0], {
        sessionID: "sdk-session-1",
        directory: "D:/resume-repo",
      });
      assert.deepEqual(session.resumeCursor, {
        sessionId: "sdk-session-1",
        cwd: "D:/repo",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("interrupts the active OpenCode turn through session.abort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });

      const started = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "interrupt me",
        attachments: [],
      });

      yield* adapter.interruptTurn(THREAD_ID, started.turnId);

      assert.deepEqual(harness.mocks.abortSession.mock.calls[0]?.[0], {
        sessionID: "sdk-session-1",
        directory: "D:/repo",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reads thread history and rolls back the latest user turn", () => {
    const harness = makeHarness();
    const messagesBefore = [
      makeMessageEntry({ id: "user-message-1", role: "user", created: 1 }),
      makeMessageEntry({
        id: "assistant-message-1",
        role: "assistant",
        parentID: "user-message-1",
        created: 2,
      }),
      makeMessageEntry({ id: "user-message-2", role: "user", created: 3 }),
    ];
    const messagesAfter = messagesBefore.slice(0, 2);

    harness.mocks.listMessages
      .mockResolvedValueOnce({ data: messagesBefore })
      .mockResolvedValueOnce({ data: messagesBefore })
      .mockResolvedValueOnce({ data: messagesAfter });

    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });

      const thread = yield* adapter.readThread(THREAD_ID);
      assert.equal(thread.turns.length, 2);
      assert.equal(thread.turns[0]?.id, opencodeTurnId("user-message-1"));
      assert.equal(thread.turns[1]?.id, opencodeTurnId("user-message-2"));

      const rolledBack = yield* adapter.rollbackThread(THREAD_ID, 1);
      assert.deepEqual(harness.mocks.revertSession.mock.calls[0]?.[0], {
        sessionID: "sdk-session-1",
        directory: "D:/repo",
        messageID: "user-message-2",
      });
      assert.equal(rolledBack.turns.length, 1);
      assert.equal(rolledBack.turns[0]?.id, opencodeTurnId("user-message-1"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("responds to permission requests after permission.asked events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "run a command",
        attachments: [],
      });

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "permission.asked",
          properties: {
            id: "permission-request-1",
            sessionID: "sdk-session-1",
            permission: "bash",
            patterns: ["*"],
            metadata: {
              message: "Allow command execution?",
            },
            always: [],
          },
        },
      } as GlobalEvent);

      yield* flushAsyncWork;
      yield* adapter.respondToRequest(THREAD_ID, APPROVAL_REQUEST_ID, "acceptForSession");

      assert.deepEqual(harness.mocks.permissionReply.mock.calls[0]?.[0], {
        requestID: "permission-request-1",
        directory: "D:/repo",
        reply: "always",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("responds to user-input requests after question.asked events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Which sandbox mode?",
        attachments: [],
      });

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "question.asked",
          properties: {
            id: "question-request-1",
            sessionID: "sdk-session-1",
            questions: [
              {
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "Workspace Write",
                    description: "Allow writing inside the workspace",
                  },
                ],
              },
            ],
          },
        },
      } as GlobalEvent);

      yield* flushAsyncWork;
      yield* adapter.respondToUserInput(THREAD_ID, USER_INPUT_REQUEST_ID, {
        "question-request-1:0": "Workspace Write",
      });

      assert.deepEqual(harness.mocks.questionReply.mock.calls[0]?.[0], {
        requestID: "question-request-1",
        directory: "D:/repo",
        answers: [["Workspace Write"]],
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rejects OpenCode user-input requests when no answers are provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Which sandbox mode?",
        attachments: [],
      });

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "question.asked",
          properties: {
            id: "question-request-1",
            sessionID: "sdk-session-1",
            questions: [
              {
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "Workspace Write",
                    description: "Allow writing inside the workspace",
                  },
                ],
              },
            ],
          },
        },
      } as GlobalEvent);

      yield* flushAsyncWork;
      yield* adapter.respondToUserInput(THREAD_ID, USER_INPUT_REQUEST_ID, {
        "question-request-1:0": "",
      });

      assert.deepEqual(harness.mocks.questionReject.mock.calls[0]?.[0], {
        requestID: "question-request-1",
        directory: "D:/repo",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("emits turn.proposed.delta and turn.proposed.completed for plan-mode turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      // Collect enough events: session lifecycle (4) + turn lifecycle events + proposed events.
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 16).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Plan a refactoring",
        attachments: [],
        interactionMode: "plan",
      });

      const providerUserMessageId = harness.inputs.promptAsync?.messageID;
      assert.equal(typeof providerUserMessageId, "string");
      if (!providerUserMessageId) {
        return;
      }

      // Emit assistant message delta with text content.
      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "sdk-session-1",
            messageID: "assistant-plan-msg-1",
            partID: "part-text-1",
            delta: "Step 1: Extract interface\n",
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "sdk-session-1",
            messageID: "assistant-plan-msg-1",
            partID: "part-text-1",
            delta: "Step 2: Move implementations",
          },
        },
      } as GlobalEvent);

      // Complete the assistant message, then let session.idle close the turn.
      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "sdk-session-1",
            info: {
              id: "assistant-plan-msg-1",
              sessionID: "sdk-session-1",
              role: "assistant",
              time: {
                created: 2,
                completed: 3,
              },
              parentID: providerUserMessageId,
              modelID: "gpt-5",
              providerID: "openai",
              mode: "default",
              agent: "plan",
              path: {
                cwd: "D:/repo",
                root: "D:/repo",
              },
              cost: 0,
              tokens: {
                total: 10,
                input: 5,
                output: 5,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
            },
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "session.idle",
          properties: {
            sessionID: "sdk-session-1",
            status: {
              type: "idle",
            },
          },
        },
      } as GlobalEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      // Verify turn.proposed.delta events were emitted.
      const proposedDeltas = runtimeEvents.filter((event) => event.type === "turn.proposed.delta");
      assert.equal(proposedDeltas.length, 2);
      assert.equal(
        (proposedDeltas[0]!.payload as { delta: string }).delta,
        "Step 1: Extract interface\n",
      );
      assert.equal(
        (proposedDeltas[1]!.payload as { delta: string }).delta,
        "Step 2: Move implementations",
      );

      // Verify turn.proposed.completed was emitted.
      const proposedCompleted = runtimeEvents.find(
        (event) => event.type === "turn.proposed.completed",
      );
      assert.isDefined(proposedCompleted);
      assert.equal(
        (proposedCompleted!.payload as { planMarkdown: string }).planMarkdown,
        "Step 1: Extract interface\nStep 2: Move implementations",
      );

      // Verify content.delta events were also emitted alongside proposed deltas.
      const contentDeltas = runtimeEvents.filter((event) => event.type === "content.delta");
      assert.isAbove(contentDeltas.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not emit proposed plan events for non-plan-mode turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      // Collect events: session lifecycle (4) + turn start + state (2) + delta + item (3) + completion (3) = 12.
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 12).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "opencode",
        cwd: "D:/repo",
        runtimeMode: "full-access",
      });

      // No interactionMode set (default mode).
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      const providerUserMessageId = harness.inputs.promptAsync?.messageID;
      assert.equal(typeof providerUserMessageId, "string");
      if (!providerUserMessageId) {
        return;
      }

      // Emit assistant message delta.
      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "sdk-session-1",
            messageID: "assistant-msg-1",
            partID: "part-text-1",
            delta: "A normal response",
          },
        },
      } as GlobalEvent);

      // Complete the assistant message, then let session.idle close the turn.
      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "sdk-session-1",
            info: {
              id: "assistant-msg-1",
              sessionID: "sdk-session-1",
              role: "assistant",
              time: {
                created: 2,
                completed: 3,
              },
              parentID: providerUserMessageId,
              modelID: "gpt-5",
              providerID: "openai",
              mode: "default",
              agent: "build",
              path: {
                cwd: "D:/repo",
                root: "D:/repo",
              },
              cost: 0,
              tokens: {
                total: 2,
                input: 1,
                output: 1,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
            },
          },
        },
      } as GlobalEvent);

      harness.eventStream.emit({
        directory: "D:/repo",
        payload: {
          type: "session.idle",
          properties: {
            sessionID: "sdk-session-1",
            status: {
              type: "idle",
            },
          },
        },
      } as GlobalEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      // Verify NO proposed plan events were emitted.
      const proposedEvents = runtimeEvents.filter(
        (event) => event.type === "turn.proposed.delta" || event.type === "turn.proposed.completed",
      );
      assert.equal(proposedEvents.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
