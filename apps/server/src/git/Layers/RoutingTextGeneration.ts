/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI, Claude CLI, or OpenCode server implementation based on the
 * provider in each request input.
 *
 * @module RoutingTextGeneration
 */
import { Effect, Layer, Context } from "effect";

import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { ForgeTextGenerationLive } from "./ForgeTextGeneration.ts";
import { GitHubCopilotTextGenerationLive } from "./GitHubCopilotTextGeneration.ts";
import { OpencodeTextGenerationLive } from "./OpencodeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends Context.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends Context.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

class ForgeTextGen extends Context.Service<ForgeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ForgeTextGen",
) {}

class OpencodeTextGen extends Context.Service<OpencodeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/OpencodeTextGen",
) {}

class GitHubCopilotTextGen extends Context.Service<GitHubCopilotTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/GitHubCopilotTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const forge = yield* ForgeTextGen;
  const opencode = yield* OpencodeTextGen;
  const githubCopilot = yield* GitHubCopilotTextGen;

  return {
    generateCommitMessage: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generateCommitMessage(input);
        case "claudeAgent":
          return claude.generateCommitMessage(input);
        case "forgecode":
          return forge.generateCommitMessage(input);
        case "opencode":
          return opencode.generateCommitMessage(input);
        case "githubCopilot":
          return githubCopilot.generateCommitMessage(input);
      }
    },
    generatePrContent: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generatePrContent(input);
        case "claudeAgent":
          return claude.generatePrContent(input);
        case "forgecode":
          return forge.generatePrContent(input);
        case "opencode":
          return opencode.generatePrContent(input);
        case "githubCopilot":
          return githubCopilot.generatePrContent(input);
      }
    },
    generateBranchName: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generateBranchName(input);
        case "claudeAgent":
          return claude.generateBranchName(input);
        case "forgecode":
          return forge.generateBranchName(input);
        case "opencode":
          return opencode.generateBranchName(input);
        case "githubCopilot":
          return githubCopilot.generateBranchName(input);
      }
    },
    generateThreadTitle: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generateThreadTitle(input);
        case "claudeAgent":
          return claude.generateThreadTitle(input);
        case "forgecode":
          return forge.generateThreadTitle(input);
        case "opencode":
          return opencode.generateThreadTitle(input);
        case "githubCopilot":
          return githubCopilot.generateThreadTitle(input);
      }
    },
    generateActivityGroupTitle: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
          return codex.generateActivityGroupTitle(input);
        case "claudeAgent":
          return claude.generateActivityGroupTitle(input);
        case "forgecode":
          return forge.generateActivityGroupTitle(input);
        case "opencode":
          return opencode.generateActivityGroupTitle(input);
        case "githubCopilot":
          return githubCopilot.generateActivityGroupTitle(input);
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

const InternalForgeLayer = Layer.effect(
  ForgeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ForgeTextGenerationLive));

const InternalOpencodeLayer = Layer.effect(
  OpencodeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(OpencodeTextGenerationLive));

const InternalGitHubCopilotLayer = Layer.effect(
  GitHubCopilotTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(GitHubCopilotTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalForgeLayer),
  Layer.provide(InternalOpencodeLayer),
  Layer.provide(InternalGitHubCopilotLayer),
);
