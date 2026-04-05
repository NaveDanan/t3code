import type {
  FilePartInput,
  GlobalEvent,
  OpencodeClient,
  Session as OpencodeSdkSession,
  TextPartInput,
} from "@opencode-ai/sdk/v2";
import { ThreadId } from "@t3tools/contracts";
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

  it.effect("starts a turn with a resolved OpenCode model without forcing a messageID", () => {
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

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
        },
      });

      assert.deepEqual(harness.inputs.createSession, {
        directory: "D:/repo",
      });

      const promptInput = harness.inputs.promptAsync;
      assert.equal(promptInput?.sessionID, "sdk-session-1");
      assert.equal(promptInput?.directory, "D:/repo");
      assert.isUndefined(promptInput?.messageID);
      assert.deepEqual(promptInput?.model, {
        providerID: "openai",
        modelID: "gpt-5",
      });
      assert.deepEqual(promptInput?.parts, [
        {
          type: "text",
          text: "hello",
        },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

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
});
