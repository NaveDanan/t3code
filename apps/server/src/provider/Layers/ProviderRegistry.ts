/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { HarnessUpdateResult, ProviderKind, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive } from "./CursorProvider";
import { ForgeProviderLive } from "./ForgeProvider";
import { GitHubCopilotProviderLive } from "./GitHubCopilotProvider";
import { OpencodeProviderLive } from "./OpencodeProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { CursorProviderShape } from "../Services/CursorProvider";
import { CursorProvider } from "../Services/CursorProvider";
import type { ForgeProviderShape } from "../Services/ForgeProvider";
import { ForgeProvider } from "../Services/ForgeProvider";
import type { GitHubCopilotProviderShape } from "../Services/GitHubCopilotProvider";
import { GitHubCopilotProvider } from "../Services/GitHubCopilotProvider";
import type { OpencodeProviderShape } from "../Services/OpencodeProvider";
import { OpencodeProvider } from "../Services/OpencodeProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";

const loadProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
  cursorProvider: CursorProviderShape,
  forgeProvider: ForgeProviderShape,
  opencodeProvider: OpencodeProviderShape,
  githubCopilotProvider: GitHubCopilotProviderShape,
): Effect.Effect<
  readonly [
    ServerProvider,
    ServerProvider,
    ServerProvider,
    ServerProvider,
    ServerProvider,
    ServerProvider,
  ]
> =>
  Effect.all(
    [
      codexProvider.getSnapshot,
      claudeProvider.getSnapshot,
      cursorProvider.getSnapshot,
      forgeProvider.getSnapshot,
      opencodeProvider.getSnapshot,
      githubCopilotProvider.getSnapshot,
    ],
    {
      concurrency: "unbounded",
    },
  );

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const cursorProvider = yield* CursorProvider;
    const forgeProvider = yield* ForgeProvider;
    const opencodeProvider = yield* OpencodeProvider;
    const githubCopilotProvider = yield* GitHubCopilotProvider;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* loadProviders(
        codexProvider,
        claudeProvider,
        cursorProvider,
        forgeProvider,
        opencodeProvider,
        githubCopilotProvider,
      ),
    );

    const syncProviders = Effect.fn("syncProviders")(function* (options?: {
      readonly publish?: boolean;
    }) {
      const previousProviders = yield* Ref.get(providersRef);
      const providers = yield* loadProviders(
        codexProvider,
        claudeProvider,
        cursorProvider,
        forgeProvider,
        opencodeProvider,
        githubCopilotProvider,
      );
      yield* Ref.set(providersRef, providers);

      if (options?.publish !== false && haveProvidersChanged(previousProviders, providers)) {
        yield* PubSub.publish(changesPubSub, providers);
      }

      return providers;
    });

    yield* Stream.runForEach(codexProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(claudeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(cursorProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(forgeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(opencodeProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );
    yield* Stream.runForEach(githubCopilotProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "codex":
          yield* codexProvider.refresh;
          break;
        case "claudeAgent":
          yield* claudeProvider.refresh;
          break;
        case "cursorAgent":
          yield* cursorProvider.refresh;
          break;
        case "forgecode":
          yield* forgeProvider.refresh;
          break;
        case "opencode":
          yield* opencodeProvider.refresh;
          break;
        case "githubCopilot":
          yield* githubCopilotProvider.refresh;
          break;
        default:
          yield* Effect.all(
            [
              codexProvider.refresh,
              claudeProvider.refresh,
              cursorProvider.refresh,
              forgeProvider.refresh,
              opencodeProvider.refresh,
              githubCopilotProvider.refresh,
            ],
            {
              concurrency: "unbounded",
            },
          );
          break;
      }
      return yield* syncProviders();
    });

    return {
      getProviders: syncProviders({ publish: false }).pipe(
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed(() => []),
      ),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => []),
        ),
      updateAll: Effect.all(
        [
          codexProvider.update,
          claudeProvider.update,
          cursorProvider.update,
          forgeProvider.update,
          opencodeProvider.update,
          githubCopilotProvider.update,
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.tap(() => syncProviders()),
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed((): ReadonlyArray<HarnessUpdateResult> => []),
      ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CursorProviderLive),
  Layer.provideMerge(ForgeProviderLive),
  Layer.provideMerge(GitHubCopilotProviderLive),
  Layer.provideMerge(OpencodeProviderLive),
);
