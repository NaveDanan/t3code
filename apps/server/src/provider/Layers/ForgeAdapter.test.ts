import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ForgeAdapter } from "../Services/ForgeAdapter.ts";
import type { ForgeCliApi, ForgeCommandInput, ForgeExecutionTarget } from "../forgecode.ts";
import { makeForgeAdapterLive } from "./ForgeAdapter.ts";

vi.mock("../forgecode.ts", async () => {
  const actual = await vi.importActual<typeof import("../forgecode.ts")>("../forgecode.ts");
  return {
    ...actual,
    resolveForgeExecutionTarget: async (input: {
      readonly executionBackend: ForgeExecutionTarget["executionBackend"];
      readonly wslDistro?: string;
    }) => ({
      executionBackend: input.executionBackend,
      ...(input.executionBackend === "wsl" && input.wslDistro
        ? { wslDistro: input.wslDistro }
        : {}),
    }),
  };
});

const THREAD_ID = ThreadId.makeUnsafe("forge-thread-1");
const CONVERSATION_ID = "forge-conversation-1";
const MODEL_CATALOG_OUTPUT = [
  "MODEL            PROVIDER           PROVIDER ID        ID                  CONTEXT WINDOW  TOOLS  IMAGE",
  "GPT-5.4          GitHub Copilot     github_copilot    gpt-5.4             128k            [yes]  [no]",
].join("\n");
const AGENT_CATALOG_OUTPUT = [
  "AGENT            ID                 DESCRIPTION",
  "Forge            forge              Default agent",
  "Muse             muse               Planning agent",
].join("\n");

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  close(code: number, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

function processResult(
  overrides?: Partial<{
    stdout: string;
    stderr: string;
    code: number;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>,
) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

function buildConversationDump(
  turns: ReadonlyArray<{
    userText: string;
    assistantText: string;
    toolCalls?: ReadonlyArray<{
      name: string;
      callId: string;
      args: unknown;
      resultText?: string;
      isError?: boolean;
    }>;
  }>,
): string {
  const messages = turns.flatMap((turn, index) => [
    {
      text: {
        role: "User",
        content: turn.userText,
      },
      usage: {
        total_tokens: { actual: 120 + index },
        prompt_tokens: { actual: 80 + index },
        completion_tokens: { actual: 40 },
        cost: 0.12,
      },
    },
    {
      text: {
        role: "Assistant",
        content: turn.assistantText,
        ...(turn.toolCalls && turn.toolCalls.length > 0
          ? {
              tool_calls: turn.toolCalls.map((toolCall) => ({
                name: toolCall.name,
                call_id: toolCall.callId,
                arguments: toolCall.args,
              })),
            }
          : {}),
      },
    },
    ...(turn.toolCalls ?? []).flatMap((toolCall) =>
      toolCall.resultText !== undefined || toolCall.isError === true
        ? [
            {
              tool: {
                name: toolCall.name,
                call_id: toolCall.callId,
                output: {
                  is_error: toolCall.isError === true,
                  values: toolCall.resultText ? [{ text: toolCall.resultText }] : [],
                },
              },
            },
          ]
        : [],
    ),
  ]);

  return JSON.stringify({
    conversation: {
      id: CONVERSATION_ID,
      context: {
        conversation_id: CONVERSATION_ID,
        messages,
      },
    },
  });
}

interface FakeForgeState {
  currentAssistantText?: string;
  includeCurrentTurn: boolean;
  currentToolCalls?: ReadonlyArray<{
    name: string;
    callId: string;
    args: unknown;
    resultText?: string;
    isError?: boolean;
  }>;
  currentTranscript?: string;
}

const RAW_FORGE_TRANSCRIPT = [
  "Initialize ... Planning task workflow",
  "Read Todos",
  "Update Todos 3 item(s)",
  "Execute [cmd.exe] bun fmt",
].join("\n");

function makeFakeCliApi(state: FakeForgeState): ForgeCliApi {
  return {
    run: async (input: ForgeCommandInput) => {
      const args = [...input.args];
      if (args[0] === "list" && args[1] === "agent") {
        return processResult({ stdout: AGENT_CATALOG_OUTPUT });
      }
      if (args[0] === "list" && args[1] === "model") {
        return processResult({ stdout: MODEL_CATALOG_OUTPUT });
      }
      if (args[0] === "conversation" && args[1] === "show") {
        return processResult({
          stdout: state.currentTranscript ? `${state.currentTranscript}\n` : "",
        });
      }
      if (args[0] === "conversation" && args[1] === "dump") {
        if (!input.cwd) {
          throw new Error("conversation dump requires a cwd");
        }
        const dump = buildConversationDump([
          {
            userText: "Previous prompt",
            assistantText: "Previous answer",
          },
          ...(state.includeCurrentTurn
            ? [
                {
                  userText: "Current prompt",
                  assistantText: state.currentAssistantText ?? "",
                  ...(state.currentToolCalls ? { toolCalls: state.currentToolCalls } : {}),
                },
              ]
            : []),
        ]);
        await writeFile(join(input.cwd, "conversation-dump.json"), dump, "utf8");
        return processResult({ stdout: "dumped\n" });
      }
      throw new Error(`Unexpected Forge CLI args: ${args.join(" ")}`);
    },
    spawn: (_input: ForgeCommandInput) => {
      const child = new FakeChildProcess();
      state.currentTranscript = RAW_FORGE_TRANSCRIPT;

      setTimeout(() => {
        state.includeCurrentTurn = true;
        state.currentAssistantText = "Fresh";
      }, 350);

      setTimeout(() => {
        state.currentAssistantText = "Fresh answer";
      }, 650);

      setTimeout(() => {
        child.close(0);
      }, 950);

      return {
        process: child as never,
        kill: () => child.close(130, "SIGTERM"),
      };
    },
  };
}

function makeTranscriptStreamingCliApi(state: FakeForgeState): ForgeCliApi {
  return {
    run: async (input: ForgeCommandInput) => {
      const args = [...input.args];
      if (args[0] === "list" && args[1] === "agent") {
        return processResult({ stdout: AGENT_CATALOG_OUTPUT });
      }
      if (args[0] === "list" && args[1] === "model") {
        return processResult({ stdout: MODEL_CATALOG_OUTPUT });
      }
      if (args[0] === "conversation" && args[1] === "show") {
        return processResult({
          stdout: state.currentTranscript ? `${state.currentTranscript}\n` : "",
        });
      }
      if (args[0] === "conversation" && args[1] === "dump") {
        if (!input.cwd) {
          throw new Error("conversation dump requires a cwd");
        }
        const dump = buildConversationDump([
          {
            userText: "Previous prompt",
            assistantText: "Previous answer",
          },
          ...(state.includeCurrentTurn
            ? [
                {
                  userText: "Current prompt",
                  assistantText: state.currentAssistantText ?? "",
                },
              ]
            : []),
        ]);
        await writeFile(join(input.cwd, "conversation-dump.json"), dump, "utf8");
        return processResult({ stdout: "dumped\n" });
      }
      throw new Error(`Unexpected Forge CLI args: ${args.join(" ")}`);
    },
    spawn: (_input: ForgeCommandInput) => {
      const child = new FakeChildProcess();
      state.currentTranscript = RAW_FORGE_TRANSCRIPT;

      setTimeout(() => {
        child.stdout.write(`${RAW_FORGE_TRANSCRIPT}\n`);
      }, 150);

      setTimeout(() => {
        state.includeCurrentTurn = true;
        state.currentAssistantText = "Fresh answer";
      }, 350);

      setTimeout(() => {
        child.close(0);
      }, 650);

      return {
        process: child as never,
        kill: () => child.close(130, "SIGTERM"),
      };
    },
  };
}

function makeToolingCliApi(): ForgeCliApi {
  const state: FakeForgeState = {
    currentAssistantText: "",
    includeCurrentTurn: false,
    currentToolCalls: [],
  };

  return {
    run: async (input: ForgeCommandInput) => {
      const args = [...input.args];
      if (args[0] === "list" && args[1] === "agent") {
        return processResult({ stdout: AGENT_CATALOG_OUTPUT });
      }
      if (args[0] === "list" && args[1] === "model") {
        return processResult({ stdout: MODEL_CATALOG_OUTPUT });
      }
      if (args[0] === "conversation" && args[1] === "show") {
        return processResult({
          stdout: state.currentTranscript ? `${state.currentTranscript}\n` : "",
        });
      }
      if (args[0] === "conversation" && args[1] === "dump") {
        if (!input.cwd) {
          throw new Error("conversation dump requires a cwd");
        }
        const dump = buildConversationDump([
          {
            userText: "Previous prompt",
            assistantText: "Previous answer",
          },
          ...(state.includeCurrentTurn
            ? [
                {
                  userText: "Current prompt",
                  assistantText: state.currentAssistantText ?? "",
                  ...(state.currentToolCalls ? { toolCalls: state.currentToolCalls } : {}),
                },
              ]
            : []),
        ]);
        await writeFile(join(input.cwd, "conversation-dump.json"), dump, "utf8");
        return processResult({ stdout: "dumped\n" });
      }
      throw new Error(`Unexpected Forge CLI args: ${args.join(" ")}`);
    },
    spawn: (_input: ForgeCommandInput) => {
      const child = new FakeChildProcess();

      setTimeout(() => {
        state.includeCurrentTurn = true;
        state.currentToolCalls = [
          {
            name: "Shell",
            callId: "call-shell-1",
            args: { command: ["bun", "run", "lint"] },
          },
        ];
      }, 100);

      setTimeout(() => {
        state.currentToolCalls = [
          {
            name: "Shell",
            callId: "call-shell-1",
            args: { command: ["bun", "run", "lint"] },
          },
        ];
      }, 620);

      setTimeout(() => {
        state.currentToolCalls = [
          {
            name: "Shell",
            callId: "call-shell-1",
            args: { command: ["bun", "run", "lint"] },
            resultText: "lint complete",
          },
          {
            name: "WriteFile",
            callId: "call-write-1",
            args: { filePath: "apps/web/src/components/ChatView.tsx" },
          },
          {
            name: "Sage",
            callId: "call-sage-1",
            args: { tasks: ["Review the new layout and summarize risks"] },
          },
        ];
        state.currentAssistantText = "Fresh answer";
      }, 860);

      setTimeout(() => {
        state.currentToolCalls = [
          {
            name: "Shell",
            callId: "call-shell-1",
            args: { command: ["bun", "run", "lint"] },
            resultText: "lint complete",
          },
          {
            name: "WriteFile",
            callId: "call-write-1",
            args: { filePath: "apps/web/src/components/ChatView.tsx" },
            resultText: "wrote ChatView",
          },
          {
            name: "Sage",
            callId: "call-sage-1",
            args: { tasks: ["Review the new layout and summarize risks"] },
            resultText: "subagent finished",
          },
        ];
      }, 1_050);

      setTimeout(() => {
        child.close(0);
      }, 1_250);

      return {
        process: child as never,
        kill: () => child.close(130, "SIGTERM"),
      };
    },
  };
}

function collectEventsThroughTurnCompletion(stream: Stream.Stream<ProviderRuntimeEvent>) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const collector = yield* Stream.runForEach(stream, (event) =>
      Queue.offer(queue, event).pipe(Effect.asVoid),
    ).pipe(Effect.forkChild);

    const events: ProviderRuntimeEvent[] = [];
    while (true) {
      const event = yield* Queue.take(queue);
      events.push(event);
      if (event.type === "turn.completed") {
        break;
      }
    }

    yield* Fiber.interrupt(collector);
    return events;
  });
}

describe("ForgeAdapter live assistant streaming", () => {
  it("streams only the new assistant message from parsed turn snapshots", async () => {
    const state: FakeForgeState = {
      includeCurrentTurn: false,
    };

    const layer = makeForgeAdapterLive({
      cliApiFactory: () => makeFakeCliApi(state),
    }).pipe(
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            forgecode: {
              enabled: true,
              binaryPath: "forge",
              executionBackend: "native",
            },
          },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ForgeAdapter;

        yield* adapter.startSession({
          provider: "forgecode",
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          cwd: "D:/Projects/t3code",
          resumeCursor: {
            conversationId: CONVERSATION_ID,
            cwd: "D:/Projects/t3code",
            executionBackend: "native",
          },
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Current prompt",
          interactionMode: "default",
        });

        return yield* collectEventsThroughTurnCompletion(adapter.streamEvents);
      }).pipe(Effect.provide(layer)),
    );

    const contentDeltas = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
        event.type === "content.delta",
    );
    expect(contentDeltas.length).toBeGreaterThan(0);
    expect(contentDeltas.map((event) => event.payload.delta).join("")).toBe("Fresh answer");
    expect(contentDeltas.some((event) => event.payload.delta.includes("Previous answer"))).toBe(
      false,
    );

    const turnCompletedIndex = events.findIndex((event) => event.type === "turn.completed");
    const lastDeltaIndex = events.findLastIndex((event) => event.type === "content.delta");
    assert.notStrictEqual(turnCompletedIndex, -1);
    assert.notStrictEqual(lastDeltaIndex, -1);
    expect(lastDeltaIndex).toBeLessThan(turnCompletedIndex);

    const completedAssistantItem = events.find(
      (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
        event.type === "item.completed" && event.payload.itemType === "assistant_message",
    );
    expect(completedAssistantItem?.payload.detail).toBe("Fresh answer");
  });

  it("ignores transcript stdout and only emits structured assistant text", async () => {
    const state: FakeForgeState = {
      includeCurrentTurn: false,
    };

    const layer = makeForgeAdapterLive({
      cliApiFactory: () => makeTranscriptStreamingCliApi(state),
    }).pipe(
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            forgecode: {
              enabled: true,
              binaryPath: "forge",
              executionBackend: "native",
            },
          },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ForgeAdapter;

        yield* adapter.startSession({
          provider: "forgecode",
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          cwd: "D:/Projects/t3code",
          resumeCursor: {
            conversationId: CONVERSATION_ID,
            cwd: "D:/Projects/t3code",
            executionBackend: "native",
          },
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Current prompt",
          interactionMode: "default",
        });

        return yield* collectEventsThroughTurnCompletion(adapter.streamEvents);
      }).pipe(Effect.provide(layer)),
    );

    const contentDeltas = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
        event.type === "content.delta",
    );
    expect(contentDeltas.length).toBeGreaterThan(0);
    expect(contentDeltas.map((event) => event.payload.delta).join("")).toBe("Fresh answer");
    expect(
      contentDeltas.some(
        (event) =>
          event.payload.delta.includes("Planning task workflow") ||
          event.payload.delta.includes("Execute [cmd.exe] bun fmt"),
      ),
    ).toBe(false);

    const completedAssistantItem = events.find(
      (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
        event.type === "item.completed" && event.payload.itemType === "assistant_message",
    );
    expect(completedAssistantItem?.payload.detail).toBe("Fresh answer");
  });

  it("maps Forge tool calls onto the shared work-log metadata", async () => {
    const layer = makeForgeAdapterLive({
      cliApiFactory: () => makeToolingCliApi(),
    }).pipe(
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: {
            forgecode: {
              enabled: true,
              binaryPath: "forge",
              executionBackend: "native",
            },
          },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ForgeAdapter;

        yield* adapter.startSession({
          provider: "forgecode",
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          cwd: "D:/Projects/t3code",
          resumeCursor: {
            conversationId: CONVERSATION_ID,
            cwd: "D:/Projects/t3code",
            executionBackend: "native",
          },
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Current prompt",
          interactionMode: "default",
        });

        return yield* collectEventsThroughTurnCompletion(adapter.streamEvents);
      }).pipe(Effect.provide(layer)),
    );

    const completedToolEvents = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
        event.type === "item.completed" && event.payload.itemType !== "assistant_message",
    );
    const liveToolUpdateIndex = events.findIndex(
      (event) => event.type === "item.updated" && event.payload.itemType === "command_execution",
    );
    const turnCompletedIndex = events.findIndex((event) => event.type === "turn.completed");

    expect(liveToolUpdateIndex).toBeGreaterThan(-1);
    expect(turnCompletedIndex).toBeGreaterThan(liveToolUpdateIndex);

    expect(completedToolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            itemType: "command_execution",
            title: "Command run",
            detail: "bun run lint",
            data: expect.objectContaining({
              toolName: "Shell",
              input: { command: ["bun", "run", "lint"] },
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            itemType: "file_change",
            title: "File change",
            detail: "apps/web/src/components/ChatView.tsx",
            data: expect.objectContaining({
              toolName: "WriteFile",
              input: { filePath: "apps/web/src/components/ChatView.tsx" },
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            itemType: "collab_agent_tool_call",
            title: "Subagent task",
            detail: "Review the new layout and summarize risks",
            data: expect.objectContaining({
              toolName: "Sage",
              input: { tasks: ["Review the new layout and summarize risks"] },
            }),
          }),
        }),
      ]),
    );
  });
});
