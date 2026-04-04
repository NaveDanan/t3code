/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * `opencode` is wired into the shared model-selection contracts before its git
 * text-generation layer exists, so requests for that provider fail explicitly
 * instead of silently falling back to another harness.
 *
 * @module RoutingTextGeneration
 */
import { Effect, Layer, ServiceMap } from "effect";
import { TextGenerationError } from "@t3tools/contracts";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const unsupportedProvider = <T>(operation: string, provider: TextGenerationProvider) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `Provider '${provider}' does not support git text generation yet.`,
      }),
    ) as Effect.Effect<T, TextGenerationError>;

  return {
    generateCommitMessage: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generateCommitMessage(input);
        case "claudeAgent":
          return claude.generateCommitMessage(input);
        case "opencode":
          return unsupportedProvider(
            "RoutingTextGeneration.generateCommitMessage",
            input.modelSelection.provider,
          );
      }
    },
    generatePrContent: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generatePrContent(input);
        case "claudeAgent":
          return claude.generatePrContent(input);
        case "opencode":
          return unsupportedProvider(
            "RoutingTextGeneration.generatePrContent",
            input.modelSelection.provider,
          );
      }
    },
    generateBranchName: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generateBranchName(input);
        case "claudeAgent":
          return claude.generateBranchName(input);
        case "opencode":
          return unsupportedProvider(
            "RoutingTextGeneration.generateBranchName",
            input.modelSelection.provider,
          );
      }
    },
    generateThreadTitle: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generateThreadTitle(input);
        case "claudeAgent":
          return claude.generateThreadTitle(input);
        case "opencode":
          return unsupportedProvider(
            "RoutingTextGeneration.generateThreadTitle",
            input.modelSelection.provider,
          );
      }
    },
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(Layer.provide(InternalCodexLayer), Layer.provide(InternalClaudeLayer));
