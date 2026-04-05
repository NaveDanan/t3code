import type {
  FilePartInput,
  GlobalEvent,
  OpencodeClient,
  Session as OpencodeSdkSession,
  TextPartInput,
} from "@opencode-ai/sdk/v2";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
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

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-1");
const APPROVAL_REQUEST_ID = ApprovalRequestId.makeUnsafe("permission-request-1");
const USER_INPUT_REQUEST_ID = ApprovalRequestId.makeUnsafe("question-request-1");
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
    },
    mocks: {
      createSession,
      getSession,
      promptAsync,
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

  it.effect(
    "starts a turn with a resolved OpenCode model using a provider-native msg-prefixed messageID",
    () => {
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
        assert.equal(promptInput?.messageID?.startsWith("msg-"), true);
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
    },
  );

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

  it.effect("classifies cached reasoning deltas as reasoning_text runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* OpencodeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
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

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const reasoningDelta = runtimeEvents.at(-1);

      assert.isDefined(reasoningDelta);
      assert.equal(reasoningDelta?.type, "content.delta");
      if (!reasoningDelta || reasoningDelta.type !== "content.delta") {
        return;
      }

      assert.equal(reasoningDelta.turnId, turn.turnId);
      assert.equal(reasoningDelta.itemId, "reasoning-part-1");
      assert.equal(reasoningDelta.payload.streamKind, "reasoning_text");
      assert.equal(reasoningDelta.payload.delta, "thinking");
    }).pipe(Effect.provide(harness.layer));
  });

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
});
