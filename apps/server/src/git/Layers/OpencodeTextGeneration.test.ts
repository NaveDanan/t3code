import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { expect, vi } from "vitest";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { OpencodeTextGenerationLive } from "./OpencodeTextGeneration.ts";
import { RoutingTextGenerationLive } from "./RoutingTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OpencodeServerManager,
  type OpencodeServerManagerShape,
  type OpencodeServerProbe,
} from "../../provider/Services/OpencodeServerManager.ts";

function makeProbe(client: unknown): OpencodeServerProbe {
  return {
    server: {
      binaryPath: "opencode",
      url: "http://127.0.0.1:4196",
      client: client as never,
      version: "1.3.15",
    },
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
      },
    ] as never,
    knownProviders: [] as never,
    connectedProviderIds: ["openai"],
    authMethodsByProviderId: { openai: [] },
    defaultModelByProviderId: { openai: "gpt-5" },
  };
}

function makeHarness(input?: {
  readonly structuredOutput?: unknown;
  readonly assistantError?: unknown;
  readonly promptFailure?: Error;
  readonly useRoutingLayer?: boolean;
}) {
  let createInput: { directory?: string } | undefined = undefined;
  let promptInput:
    | {
        sessionID: string;
        directory?: string;
        model?: {
          providerID: string;
          modelID: string;
        };
        variant?: string;
        format?: unknown;
        parts: Array<unknown>;
      }
    | undefined = undefined;
  let deleteInput:
    | {
        sessionID: string;
        directory?: string;
      }
    | undefined = undefined;

  const sessionCreate = vi.fn(async (request: { directory?: string }) => {
    createInput = request;
    return {
      data: {
        id: "sdk-session-1",
        directory: request.directory ?? process.cwd(),
      },
    };
  });
  const sessionPrompt = vi.fn(
    async (request: {
      sessionID: string;
      directory?: string;
      model?: {
        providerID: string;
        modelID: string;
      };
      variant?: string;
      format?: unknown;
      parts: Array<unknown>;
    }) => {
      promptInput = request;
      if (input?.promptFailure) {
        throw input.promptFailure;
      }
      return {
        data: {
          info: {
            id: "assistant-message-1",
            sessionID: request.sessionID,
            role: "assistant",
            time: {
              created: 1,
              completed: 2,
            },
            parentID: "user-message-1",
            modelID: request.model?.modelID ?? "gpt-5",
            providerID: request.model?.providerID ?? "openai",
            mode: "default",
            agent: "build",
            path: {
              cwd: request.directory ?? process.cwd(),
              root: request.directory ?? process.cwd(),
            },
            cost: 0,
            tokens: {
              total: 8,
              input: 4,
              output: 4,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
            ...(input?.assistantError ? { error: input.assistantError } : {}),
            ...(input?.structuredOutput !== undefined
              ? { structured: input.structuredOutput }
              : {}),
          },
          parts: [],
        },
      };
    },
  );
  const sessionDelete = vi.fn(async (request: { sessionID: string; directory?: string }) => {
    deleteInput = request;
    return {
      data: true,
    };
  });

  const client = {
    session: {
      create: sessionCreate,
      prompt: sessionPrompt,
      delete: sessionDelete,
    },
  };
  const probe = makeProbe(client);
  const manager: OpencodeServerManagerShape = {
    ensureServer: () => Effect.succeed(probe.server),
    probe: () => Effect.succeed(probe),
    streamEvents: () => Stream.empty,
    stop: Effect.void,
  };

  const layer = (
    input?.useRoutingLayer ? RoutingTextGenerationLive : OpencodeTextGenerationLive
  ).pipe(
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          opencode: {
            binaryPath: "opencode",
          },
        },
      }),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-opencode-text-generation-test-",
      }),
    ),
    Layer.provideMerge(Layer.succeed(OpencodeServerManager, manager)),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    inputs: {
      get create() {
        return createInput;
      },
      get prompt() {
        return promptInput;
      },
      get delete() {
        return deleteInput;
      },
    },
    mocks: {
      sessionCreate,
      sessionPrompt,
      sessionDelete,
    },
    layer,
  };
}

it.layer(NodeServices.layer)("OpencodeTextGenerationLive", (it) => {
  it.effect("generates commit messages through OpenCode structured output", () => {
    const harness = makeHarness({
      structuredOutput: {
        subject: "  Add OpenCode git generation support.\nextra",
        body: "\n- wire OpenCode routing\n- add structured parsing\n",
        branch: "feature/opencode-routing",
      },
    });

    return Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-routing",
        stagedSummary: "M apps/server/src/git/Layers/RoutingTextGeneration.ts",
        stagedPatch:
          "diff --git a/apps/server/src/git/Layers/RoutingTextGeneration.ts b/apps/server/src/git/Layers/RoutingTextGeneration.ts",
        includeBranch: true,
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: {
            effort: "high",
          },
        },
      });

      expect(generated).toEqual({
        subject: "Add OpenCode git generation support",
        body: "- wire OpenCode routing\n- add structured parsing",
        branch: "feature/opencode-routing",
      });
      expect(harness.inputs.create).toEqual({
        directory: process.cwd(),
      });
      expect(harness.inputs.prompt?.model).toEqual({
        providerID: "openai",
        modelID: "gpt-5",
      });
      expect(harness.inputs.prompt?.variant).toBe("high");
      expect(harness.inputs.prompt?.format).toMatchObject({
        type: "json_schema",
      });
      expect(harness.inputs.delete).toEqual({
        sessionID: "sdk-session-1",
        directory: process.cwd(),
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("encodes image attachments as OpenCode file parts for branch generation", () => {
    const harness = makeHarness({
      structuredOutput: {
        branch: "feature/opencode-attachments",
      },
    });

    return Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const attachment = {
        id: "thread-1-11111111-1111-1111-1111-111111111111",
        type: "image" as const,
        name: "wireframe.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };

      yield* fileSystem.writeFile(
        `${config.attachmentsDir}/${attachmentRelativePath(attachment)}`,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      );

      const textGeneration = yield* TextGeneration;
      const generated = yield* textGeneration.generateBranchName({
        cwd: process.cwd(),
        message: "Use the attached mockup to derive a branch name",
        attachments: [attachment],
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
        },
      });

      expect(generated).toEqual({
        branch: "feature/opencode-attachments",
      });
      expect(harness.inputs.prompt?.parts).toHaveLength(2);
      expect(harness.inputs.prompt?.parts[1]).toMatchObject({
        type: "file",
        mime: "image/png",
        filename: "wireframe.png",
      });
      expect((harness.inputs.prompt?.parts[1] as { url?: string } | undefined)?.url).toContain(
        "data:image/png;base64,",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "fails when OpenCode returns no structured output and still cleans up the session",
    () => {
      const harness = makeHarness();

      return Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/opencode-routing",
            commitSummary: "Add OpenCode git generation",
            diffSummary: "Routing now supports OpenCode",
            diffPatch:
              "diff --git a/apps/server/src/git/Layers/RoutingTextGeneration.ts b/apps/server/src/git/Layers/RoutingTextGeneration.ts",
            modelSelection: {
              provider: "opencode",
              model: "openai/gpt-5",
            },
          })
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.detail).toBe("OpenCode returned no structured output.");
        }
        expect(harness.inputs.delete).toEqual({
          sessionID: "sdk-session-1",
          directory: process.cwd(),
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("routes OpenCode requests through RoutingTextGenerationLive", () => {
    const harness = makeHarness({
      structuredOutput: {
        title: "  Fix OpenCode routing errors  ",
      },
      useRoutingLayer: true,
    });

    return Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix OpenCode routing errors",
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
        },
      });

      expect(generated).toEqual({
        title: "Fix OpenCode routing errors",
      });
      expect(harness.mocks.sessionPrompt).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "falls back to a live OpenCode default model when the requested slug is unavailable",
    () => {
      const harness = makeHarness({
        structuredOutput: {
          title: "Use live default model",
        },
      });

      return Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Use a live catalog fallback",
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5-mini",
          },
        });

        expect(generated).toEqual({
          title: "Use live default model",
        });
        expect(harness.inputs.prompt?.model).toEqual({
          providerID: "openai",
          modelID: "gpt-5",
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
