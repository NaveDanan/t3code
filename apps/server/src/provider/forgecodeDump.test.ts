import { describe, expect, it } from "vitest";

import { parseForgeConversationDump } from "./forgecodeDump.ts";

describe("parseForgeConversationDump", () => {
  it("reconstructs turns, tool calls, usage, and assistant text from a dump", () => {
    const dump = {
      conversation: {
        id: "4df67b34-f8d0-48d9-b53b-40f0f17e57c0",
        title: "Inspect workspace state",
        context: {
          conversation_id: "4df67b34-f8d0-48d9-b53b-40f0f17e57c0",
          messages: [
            {
              text: {
                role: "User",
                content: "List the repo files.",
              },
              usage: {
                total_tokens: { actual: 120 },
                prompt_tokens: { actual: 80 },
                cached_tokens: { actual: 10 },
                completion_tokens: { actual: 40 },
                cost: 0.12,
              },
            },
            {
              text: {
                role: "Assistant",
                content: "I will inspect the workspace.",
                tool_calls: [
                  {
                    name: "shell",
                    call_id: "call-1",
                    arguments: {
                      command: "ls -la",
                    },
                  },
                ],
              },
            },
            {
              tool: {
                name: "shell",
                call_id: "call-1",
                output: {
                  is_error: false,
                  values: [
                    {
                      text: "<![CDATA[file-a.ts\nfile-b.ts]]>",
                    },
                  ],
                },
              },
            },
            {
              text: {
                role: "Assistant",
                content: "The workspace contains two files.",
              },
            },
          ],
        },
      },
    };

    const parsed = parseForgeConversationDump(JSON.stringify(dump));

    expect(parsed.conversationId).toBe("4df67b34-f8d0-48d9-b53b-40f0f17e57c0");
    expect(parsed.title).toBe("Inspect workspace state");
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]).toMatchObject({
      index: 1,
      userText: "List the repo files.",
      assistantText: "I will inspect the workspace.\n\nThe workspace contains two files.",
      usage: {
        usedTokens: 120,
        inputTokens: 80,
        cachedInputTokens: 10,
        outputTokens: 40,
        totalCostUsd: 0.12,
      },
    });
    expect(parsed.turns[0]?.toolCalls).toEqual([
      {
        callId: "call-1",
        name: "shell",
        args: {
          command: "ls -la",
        },
        detail: "ls -la",
        result: {
          callId: "call-1",
          name: "shell",
          isError: false,
          rawText: "<![CDATA[file-a.ts\nfile-b.ts]]>",
          text: "file-a.ts\nfile-b.ts",
        },
      },
    ]);
  });
});
