import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Stream } from "effect";
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

function processResult(overrides?: Partial<{
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}>) {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

function buildConversationDump(turns: ReadonlyArray<{ userText: string; assistantText: string }>): string {
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
      },
    },
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
  currentShownAssistantText?: string;
  includeCurrentTurn: boolean;
}

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
          stdout: state.currentShownAssistantText ? `${state.currentShownAssistantText}\n` : "",
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
                  assistantText: "Fresh answer",
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
      state.currentShownAssistantText = "Previous answer";

      setTimeout(() => {
        state.currentShownAssistantText = "Fresh";
        state.includeCurrentTurn = true;
      }, 350);

      setTimeout(() => {
        state.currentShownAssistantText = "Fresh answer";
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

describe("ForgeAdapter live assistant streaming", () => {
  it("streams only the new assistant message before the final dump reconciliation", async () => {
    const state: FakeForgeState = {
      currentShownAssistantText: "Previous answer",
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
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

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

        return Array.from(yield* Fiber.join(runtimeEventsFiber));
      }).pipe(Effect.provide(layer)),
    );

    const contentDeltas = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
        event.type === "content.delta",
    );
    expect(contentDeltas.map((event) => event.payload.delta)).toEqual(["Fresh", " answer"]);

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
});
