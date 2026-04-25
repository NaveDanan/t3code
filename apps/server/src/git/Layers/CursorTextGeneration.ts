/**
 * CursorTextGeneration – Text generation layer for the Cursor headless CLI.
 *
 * Uses `cursor-agent -p --output-format json` for structured JSON generation
 * of commit messages, PR content, branch names, and thread/activity titles.
 *
 * @module CursorTextGeneration
 */
import { Effect, Layer, Option, Schema } from "effect";

import { type CursorAgentModelSelection, TextGenerationError } from "@t3tools/contracts";
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
import {
  buildCursorSpawnSpec,
  resolveCursorAgentApiModelId,
  type CursorExecutionTarget,
} from "../../provider/cursorAgent.ts";

const CURSOR_TEXT_GENERATION_TIMEOUT_MS = 180_000;

function normalizeJsonCandidate(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

type CursorProcessRunner = (
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

let cursorProcessRunner: CursorProcessRunner = (command, args, options) =>
  runProcess(command, args, options);

export function setCursorTextGenerationProcessRunnerForTests(
  runner: CursorProcessRunner | null,
): void {
  cursorProcessRunner = runner ?? ((command, args, options) => runProcess(command, args, options));
}

function resolveExecutionTarget(executionBackend: "native" | "wsl"): CursorExecutionTarget {
  // Simple resolution — full probing is in the provider layer.
  return { executionBackend };
}

const makeCursorTextGeneration = Effect.gen(function* () {
  const serverSettingsService = yield* ServerSettingsService;

  const toTextGenerationError = (operation: string, error: unknown, fallback: string) =>
    normalizeCliError("cursor-agent", operation, error, fallback);

  const runCursorJson = Effect.fn("runCursorJson")(function* <S extends Schema.Top>({
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
    modelSelection: CursorAgentModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const cursorSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.cursorAgent),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to read Cursor settings.",
            cause,
          }),
      ),
    );
    const binaryPath = cursorSettings.binaryPath || "cursor-agent";
    const model = resolveCursorAgentApiModelId({
      model: modelSelection.model,
      options: modelSelection.options,
    });
    const executionTarget = resolveExecutionTarget(cursorSettings.executionBackend);

    const outputSchema = JSON.stringify(toJsonSchemaObject(outputSchemaJson), null, 2);
    const fullPrompt = [
      prompt,
      "",
      "Output requirements:",
      "- Return only a valid JSON object.",
      "- Do not wrap the JSON in markdown fences or add any surrounding text.",
      `- The JSON must conform to this schema:\n${outputSchema}`,
    ].join("\n");

    const cursorArgs: string[] = ["-p", fullPrompt, "--output-format", "json"];
    if (model && model !== "auto") {
      cursorArgs.push("--model", model);
    }

    const spec = buildCursorSpawnSpec({
      binaryPath,
      cursorArgs,
      cwd,
      executionTarget,
    });

    const result = yield* Effect.tryPromise({
      try: () =>
        cursorProcessRunner(spec.command, [...spec.args], {
          env: spec.env,
          cwd: spec.cwd ?? undefined,
          shell: spec.shell,
          allowNonZeroExit: true,
          timeoutMs: CURSOR_TEXT_GENERATION_TIMEOUT_MS,
        }),
      catch: (cause) => toTextGenerationError(operation, cause, "Cursor CLI request failed."),
    }).pipe(
      Effect.timeoutOption(CURSOR_TEXT_GENERATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Cursor CLI request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    if (result.code !== 0) {
      return yield* new TextGenerationError({
        operation,
        detail: `Cursor CLI exited with code ${result.code}: ${(result.stderr || result.stdout).trim() || "Unknown error."}`,
      });
    }

    const jsonCandidate = normalizeJsonCandidate(result.stdout);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(jsonCandidate),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Cursor CLI returned invalid JSON.",
          cause,
        }),
    });

    return yield* Schema.decodeEffect(outputSchemaJson)(parsed).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Cursor CLI returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  // ── Commit message ────────────────────────────────────────────────

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CursorTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const result = yield* runCursorJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as CursorAgentModelSelection,
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
    "CursorTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const result = yield* runCursorJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as CursorAgentModelSelection,
    });

    return {
      title: sanitizePrTitle(result.title),
      body: typeof result.body === "string" ? result.body.trim() : "",
    };
  });

  // ── Branch name ───────────────────────────────────────────────────

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CursorTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const result = yield* runCursorJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as CursorAgentModelSelection,
    });

    return {
      branch: sanitizeBranchFragment(result.branch),
    };
  });

  // ── Thread title ──────────────────────────────────────────────────

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const result = yield* runCursorJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as CursorAgentModelSelection,
    });

    return {
      title: sanitizeThreadTitle(result.title),
    };
  });

  // ── Activity group title ──────────────────────────────────────────

  const generateActivityGroupTitle: TextGenerationShape["generateActivityGroupTitle"] = Effect.fn(
    "CursorTextGeneration.generateActivityGroupTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildActivityGroupTitlePrompt({
      groupKind: input.groupKind,
      entries: input.entries,
    });

    const result = yield* runCursorJson({
      operation: "generateActivityGroupTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection as CursorAgentModelSelection,
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

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);
