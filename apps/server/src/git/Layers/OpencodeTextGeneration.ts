import type {
  AssistantMessage,
  FilePartInput,
  JsonSchema,
  Part,
  Session as OpencodeSdkSession,
  TextPartInput,
} from "@opencode-ai/sdk/v2";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";

import {
  type ChatAttachment,
  OpencodeModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpencodeServerManager } from "../../provider/Services/OpencodeServerManager.ts";
import {
  readOpencodeSdkData,
  resolveFallbackOpencodeModel,
  resolveOpencodeModel,
} from "../../provider/opencode.ts";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import {
  buildActivityGroupTitlePrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  normalizeCliError,
  sanitizeActivityGroupTitle,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";

const OPENCODE_TIMEOUT_MS = 180_000;

function preferredProviderIdFromModelSlug(model: string): string | undefined {
  const trimmed = model.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0) {
    return undefined;
  }

  return trimmed.slice(0, separatorIndex);
}

function assistantErrorMessage(error: AssistantMessage["error"]): string {
  if (!error) {
    return "OpenCode returned an unknown error.";
  }
  if ("message" in error && typeof error.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  return JSON.stringify(error);
}

const makeOpencodeTextGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const opencodeServerManager = yield* OpencodeServerManager;

  const toTextGenerationError = (operation: string, error: unknown, fallback: string) =>
    normalizeCliError("opencode", operation, error, fallback);

  const buildAttachmentParts = Effect.fn("buildAttachmentParts")(function* (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateActivityGroupTitle",
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ) {
    if (!attachments || attachments.length === 0) {
      return [] as Array<FilePartInput>;
    }

    return yield* Effect.forEach(
      attachments,
      (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new TextGenerationError({
              operation,
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }

          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: `Failed to read attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          );

          return {
            type: "file" as const,
            mime: attachment.mimeType,
            filename: attachment.name,
            url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          } satisfies FilePartInput;
        }),
      { concurrency: 1 },
    );
  });

  const runOpencodeJson = Effect.fn("runOpencodeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    attachments,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateActivityGroupTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    attachments: ReadonlyArray<ChatAttachment> | undefined;
    modelSelection: OpencodeModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const opencodeSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.opencode),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to read OpenCode settings.",
            cause,
          }),
      ),
    );
    const binaryPath = opencodeSettings.binaryPath || "opencode";

    const [server, probe, promptParts] = yield* Effect.all(
      [
        opencodeServerManager
          .ensureServer({ binaryPath })
          .pipe(
            Effect.mapError((cause) =>
              toTextGenerationError(operation, cause, "Failed to start the OpenCode server."),
            ),
          ),
        opencodeServerManager
          .probe({ binaryPath })
          .pipe(
            Effect.mapError((cause) =>
              toTextGenerationError(
                operation,
                cause,
                "Failed to query the OpenCode provider catalog.",
              ),
            ),
          ),
        buildAttachmentParts(operation, attachments),
      ],
      { concurrency: "unbounded" },
    );

    const resolvedModel =
      resolveOpencodeModel(modelSelection.model, probe) ??
      resolveFallbackOpencodeModel(probe, preferredProviderIdFromModelSlug(modelSelection.model));
    if (!resolvedModel) {
      return yield* new TextGenerationError({
        operation,
        detail: `Could not resolve OpenCode model '${modelSelection.model}' against the active provider catalog.`,
      });
    }

    const response = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          readOpencodeSdkData<OpencodeSdkSession>(
            server.client.session.create({
              directory: cwd,
            }),
            "session.create",
          ),
        catch: (cause) =>
          toTextGenerationError(operation, cause, "Failed to create an OpenCode session."),
      }),
      (session) =>
        Effect.tryPromise({
          try: () =>
            readOpencodeSdkData<{
              info: AssistantMessage;
              parts: Array<Part>;
            }>(
              server.client.session.prompt({
                sessionID: session.id,
                directory: cwd,
                model: resolvedModel,
                ...(modelSelection.options?.effort
                  ? { variant: modelSelection.options.effort }
                  : {}),
                format: {
                  type: "json_schema",
                  schema: toJsonSchemaObject(outputSchemaJson) as JsonSchema,
                },
                parts: [
                  {
                    type: "text",
                    text: prompt,
                  } satisfies TextPartInput,
                  ...promptParts,
                ],
              }),
              "session.prompt",
            ),
          catch: (cause) => toTextGenerationError(operation, cause, "OpenCode request failed."),
        }).pipe(
          Effect.timeoutOption(OPENCODE_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation,
                    detail: "OpenCode request timed out.",
                  }),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
        ),
      (session) =>
        Effect.tryPromise({
          try: () =>
            readOpencodeSdkData<void>(
              server.client.session.delete({
                sessionID: session.id,
                directory: cwd,
              }),
              "session.delete",
            ),
          catch: () => undefined,
        }).pipe(
          Effect.catch(() => Effect.void),
          Effect.asVoid,
        ),
    );

    if (response.info.error) {
      return yield* new TextGenerationError({
        operation,
        detail: `OpenCode request failed: ${assistantErrorMessage(response.info.error)}`,
        cause: response.info.error,
      });
    }

    if (response.info.structured === undefined) {
      return yield* new TextGenerationError({
        operation,
        detail: "OpenCode returned no structured output.",
        cause: response.info,
      });
    }

    return yield* Schema.decodeEffect(outputSchemaJson)(response.info.structured).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "OpenCode returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpencodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpencodeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      attachments: undefined,
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
    "OpencodeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpencodeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      attachments: undefined,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OpencodeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpencodeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      attachments: input.attachments,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpencodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpencodeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      attachments: input.attachments,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  const generateActivityGroupTitle: TextGenerationShape["generateActivityGroupTitle"] = Effect.fn(
    "OpencodeTextGeneration.generateActivityGroupTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildActivityGroupTitlePrompt({
      groupKind: input.groupKind,
      entries: input.entries,
    });

    if (input.modelSelection.provider !== "opencode") {
      return yield* new TextGenerationError({
        operation: "generateActivityGroupTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runOpencodeJson({
      operation: "generateActivityGroupTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      attachments: undefined,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeActivityGroupTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateActivityGroupTitle,
  } satisfies TextGenerationShape;
});

export const OpencodeTextGenerationLive = Layer.effect(TextGeneration, makeOpencodeTextGeneration);
