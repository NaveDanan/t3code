import { Effect, Layer, Result, Schema } from "effect";

import { type ForgeCodeModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  createForgeCliApi,
  parseForgeModelCatalogRows,
  resolveForgeExecutionTarget,
  resolveFallbackForgeModel,
  resolveForgeModel,
  splitForgeModelSlug,
  toWslPath,
  type ForgeCliApi,
} from "../../provider/forgecode.ts";
import {
  createForgeConversationId,
  deleteForgeConversation,
  dumpForgeConversation,
} from "../../provider/forgecodeRuntime.ts";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";

const FORGE_TEXT_GENERATION_AGENT = "forge";
const FORGE_TEXT_GENERATION_TIMEOUT_MS = 180_000;

export interface ForgeTextGenerationLiveOptions {
  readonly cliApi?: ForgeCliApi;
}

function preferredProviderIdFromModelSlug(model: string): string | undefined {
  return splitForgeModelSlug(model)?.providerId;
}

function normalizeJsonCandidate(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function buildForgeJsonPrompt(schema: Schema.Top, prompt: string, strictRetry: boolean): string {
  const outputSchema = JSON.stringify(toJsonSchemaObject(schema), null, 2);
  return [
    prompt,
    "",
    "Output requirements:",
    "- Return only a valid JSON object.",
    "- Do not include markdown fences, prose, or explanations before or after the JSON.",
    ...(strictRetry ? ["- Previous output was invalid. Return raw JSON only on this retry."] : []),
    "- The response must match this JSON schema exactly:",
    outputSchema,
  ].join("\n");
}

const makeForgeTextGeneration = Effect.fn("makeForgeTextGeneration")(function* (
  options?: ForgeTextGenerationLiveOptions,
) {
  const serverSettingsService = yield* ServerSettingsService;

  const toTextGenerationError = (operation: string, error: unknown, fallback: string) =>
    normalizeCliError("forge", operation, error, fallback);

  const runForgeJson = Effect.fn("runForgeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ForgeCodeModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const forgeSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.forgecode),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to read ForgeCode settings.",
            cause,
          }),
      ),
    );
    const executionTarget = yield* Effect.tryPromise({
      try: () =>
        resolveForgeExecutionTarget({
          executionBackend: forgeSettings.executionBackend,
        }),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: `ForgeCode backend '${forgeSettings.executionBackend}' is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    const cliApi = options?.cliApi ?? createForgeCliApi(executionTarget);

    const modelCatalogResult = yield* Effect.tryPromise({
      try: () =>
        cliApi.run({
          binaryPath: forgeSettings.binaryPath,
          args: ["list", "model", "--porcelain"],
          timeoutMs: FORGE_TEXT_GENERATION_TIMEOUT_MS,
        }),
      catch: (cause) =>
        toTextGenerationError(operation, cause, "Failed to query the ForgeCode model catalog."),
    });
    const catalog = parseForgeModelCatalogRows(modelCatalogResult.stdout);
    const resolvedModel =
      resolveForgeModel(modelSelection.model, catalog) ??
      resolveFallbackForgeModel(catalog, preferredProviderIdFromModelSlug(modelSelection.model));
    if (!resolvedModel) {
      return yield* new TextGenerationError({
        operation,
        detail: `Could not resolve ForgeCode model '${modelSelection.model}' against the active provider catalog.`,
      });
    }

    const runAttempt = Effect.fn("runAttempt")(function* (strictRetry: boolean) {
      const conversationId = createForgeConversationId();
      const promptText = buildForgeJsonPrompt(outputSchemaJson, prompt, strictRetry);

      return yield* Effect.acquireUseRelease(
        Effect.succeed(conversationId),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise({
              try: () =>
                cliApi.run({
                  binaryPath: forgeSettings.binaryPath,
                  cwd,
                  args: [
                    "--prompt",
                    promptText,
                    "--conversation-id",
                    conversationId,
                    "--agent",
                    FORGE_TEXT_GENERATION_AGENT,
                    "--directory",
                    executionTarget.executionBackend === "wsl" ? toWslPath(cwd) : cwd,
                  ],
                  env: {
                    FORGE_SESSION__PROVIDER_ID: resolvedModel.providerId,
                    FORGE_SESSION__MODEL_ID: resolvedModel.modelId,
                  },
                  timeoutMs: FORGE_TEXT_GENERATION_TIMEOUT_MS,
                  allowNonZeroExit: true,
                }),
              catch: (cause) =>
                toTextGenerationError(operation, cause, "ForgeCode request failed."),
            });

            const conversation = yield* Effect.tryPromise({
              try: () =>
                dumpForgeConversation({
                  binaryPath: forgeSettings.binaryPath,
                  conversationId,
                  cliApi,
                }),
              catch: (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "ForgeCode completed but the conversation dump could not be read.",
                  cause,
                }),
            });

            const latestTurn = conversation.turns.at(-1);
            const assistantText = latestTurn?.assistantText?.trim() ?? "";
            if (!assistantText) {
              return yield* new TextGenerationError({
                operation,
                detail:
                  result.code === 0
                    ? "ForgeCode returned no assistant output."
                    : `ForgeCode request failed: ${(result.stderr || result.stdout).trim() || `exit code ${result.code ?? "null"}`}.`,
              });
            }

            const parsed = yield* Effect.try({
              try: () => JSON.parse(normalizeJsonCandidate(assistantText)),
              catch: (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "ForgeCode returned invalid structured output.",
                  cause,
                }),
            });

            return yield* Schema.decodeUnknownEffect(outputSchemaJson)(parsed).pipe(
              Effect.catchTag("SchemaError", (cause) =>
                Effect.fail(
                  new TextGenerationError({
                    operation,
                    detail: "ForgeCode returned invalid structured output.",
                    cause,
                  }),
                ),
              ),
            );
          }),
        (activeConversationId) =>
          Effect.tryPromise({
            try: () =>
              deleteForgeConversation({
                binaryPath: forgeSettings.binaryPath,
                conversationId: activeConversationId,
                cliApi,
              }),
            catch: () => undefined,
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.asVoid,
          ),
      );
    });

    const firstAttempt = yield* runAttempt(false).pipe(Effect.result);
    if (Result.isSuccess(firstAttempt)) {
      return firstAttempt.success;
    }

    if (firstAttempt.failure.detail !== "ForgeCode returned invalid structured output.") {
      return yield* firstAttempt.failure;
    }

    return yield* runAttempt(true);
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ForgeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "forgecode") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runForgeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ForgeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "forgecode") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runForgeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ForgeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "forgecode") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runForgeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ForgeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "forgecode") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runForgeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const ForgeTextGenerationLive = Layer.effect(TextGeneration, makeForgeTextGeneration());

export function makeForgeTextGenerationLive(options?: ForgeTextGenerationLiveOptions) {
  return Layer.effect(TextGeneration, makeForgeTextGeneration(options));
}
