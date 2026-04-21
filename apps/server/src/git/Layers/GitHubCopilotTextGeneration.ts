/**
 * GitHubCopilotTextGeneration – Text generation layer for the GitHub Copilot
 * provider. Uses the Copilot CLI for structured JSON generation of commit
 * messages, PR content, branch names, and thread titles.
 *
 * @module GitHubCopilotTextGeneration
 */
import { Effect, Layer, Option, Schema } from "effect";

import { type GitHubCopilotModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerSettingsService } from "../../serverSettings.ts";
import { runProcess } from "../../processRunner.ts";
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

const COPILOT_TEXT_GENERATION_TIMEOUT_MS = 180_000;

function normalizeJsonCandidate(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

type CopilotProcessRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string | undefined;
    readonly shell: boolean;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
  },
) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}>;

let copilotProcessRunner: CopilotProcessRunner = (command, args, options) =>
  runProcess(command, args, options);

export function setCopilotTextGenerationProcessRunnerForTests(
  runner: CopilotProcessRunner | null,
): void {
  copilotProcessRunner = runner ?? ((command, args, options) => runProcess(command, args, options));
}

const makeGitHubCopilotTextGeneration = Effect.gen(function* () {
  const serverSettingsService = yield* ServerSettingsService;

  const toTextGenerationError = (operation: string, error: unknown, fallback: string) =>
    normalizeCliError("copilot", operation, error, fallback);

  const runCopilotJson = Effect.fn("runCopilotJson")(function* <S extends Schema.Top>({
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
      | "generateThreadTitle"
      | "generateActivityGroupTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: GitHubCopilotModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const copilotSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.githubCopilot),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to read GitHub Copilot settings.",
            cause,
          }),
      ),
    );
    const binaryPath = copilotSettings.binaryPath || "copilot";
    const model = modelSelection.model;

    const outputSchema = JSON.stringify(toJsonSchemaObject(outputSchemaJson), null, 2);
    const fullPrompt = [
      prompt,
      "",
      "Output requirements:",
      "- Return only a valid JSON object.",
      "- Do not wrap the JSON in markdown fences or add any surrounding text.",
      `- The JSON must conform to this schema:\n${outputSchema}`,
    ].join("\n");

    const result = yield* Effect.tryPromise({
      try: () =>
        copilotProcessRunner(
          binaryPath,
          ["chat", "--model", model, "--output", "json", "--message", fullPrompt],
          {
            env: process.env,
            cwd,
            shell: process.platform === "win32",
            allowNonZeroExit: true,
            timeoutMs: COPILOT_TEXT_GENERATION_TIMEOUT_MS,
          },
        ),
      catch: (cause) => toTextGenerationError(operation, cause, "Copilot CLI request failed."),
    }).pipe(
      Effect.timeoutOption(COPILOT_TEXT_GENERATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Copilot CLI request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    if (result.code !== 0) {
      return yield* new TextGenerationError({
        operation,
        detail: `Copilot CLI exited with code ${result.code}: ${(result.stderr || result.stdout).trim() || "Unknown error."}`,
      });
    }

    const jsonCandidate = normalizeJsonCandidate(result.stdout);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(jsonCandidate),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Copilot CLI returned invalid JSON.",
          cause,
        }),
    });

    return yield* Schema.decodeEffect(outputSchemaJson)(parsed).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Copilot CLI returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  // ── Commit message ────────────────────────────────────────────────

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "GitHubCopilotTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const result = yield* runCopilotJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as GitHubCopilotModelSelection,
    });

    return {
      subject: sanitizeCommitSubject(result.subject),
      body: typeof result.body === "string" ? result.body.trim() : "",
      ...("branch" in result && typeof result.branch === "string" && result.branch.trim().length > 0
        ? { branch: sanitizeFeatureBranchName(sanitizeBranchFragment(result.branch)) }
        : {}),
    };
  });

  // ── PR content ────────────────────────────────────────────────────

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "GitHubCopilotTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const result = yield* runCopilotJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as GitHubCopilotModelSelection,
    });

    return {
      title: sanitizePrTitle(result.title),
      body: typeof result.body === "string" ? result.body.trim() : "",
    };
  });

  // ── Branch name ───────────────────────────────────────────────────

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "GitHubCopilotTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
    });

    const result = yield* runCopilotJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as GitHubCopilotModelSelection,
    });

    return {
      branch: sanitizeFeatureBranchName(sanitizeBranchFragment(result.branch)),
    };
  });

  // ── Thread title ──────────────────────────────────────────────────

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "GitHubCopilotTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
    });

    const result = yield* runCopilotJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as GitHubCopilotModelSelection,
    });

    return {
      title: sanitizeThreadTitle(result.title),
    };
  });

  const generateActivityGroupTitle: TextGenerationShape["generateActivityGroupTitle"] = Effect.fn(
    "GitHubCopilotTextGeneration.generateActivityGroupTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildActivityGroupTitlePrompt({
      groupKind: input.groupKind,
      entries: input.entries,
    });

    const result = yield* runCopilotJson({
      operation: "generateActivityGroupTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as GitHubCopilotModelSelection,
    });

    return {
      title: sanitizeActivityGroupTitle(result.title),
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

export const GitHubCopilotTextGenerationLive = Layer.effect(
  TextGeneration,
  makeGitHubCopilotTextGeneration,
);
