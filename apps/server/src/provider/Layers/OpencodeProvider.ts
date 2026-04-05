import type { OpencodeSettings, ServerProviderModel } from "@t3tools/contracts";
import { Effect, Equal, Layer, Result, Stream } from "effect";

import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { OpencodeProvider } from "../Services/OpencodeProvider";
import { OpencodeServerManager } from "../Services/OpencodeServerManager";
import { OpencodeServerManagerLive } from "./OpencodeServerManager";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "opencode" as const;

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "openai/gpt-5",
    name: "OpenAI GPT-5",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "openai/gpt-5-mini",
    name: "OpenAI GPT-5 Mini",
    isCustom: false,
    capabilities: null,
  },
];

function resolveOpencodeModels(input: {
  readonly customModels: ReadonlyArray<string>;
  readonly configuredProviders: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly models: Readonly<Record<string, { readonly id: string; readonly name: string }>>;
  }>;
}): ReadonlyArray<ServerProviderModel> {
  const discoveredModels = input.configuredProviders
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        slug: `${provider.id}/${model.id}`,
        name: `${provider.name} ${model.name}`,
        isCustom: false,
        capabilities: null,
      })),
    )
    .toSorted((left, right) => left.slug.localeCompare(right.slug));

  return providerModelsFromSettings(discoveredModels, PROVIDER, input.customModels);
}

function resolveOpenCodeAuth(input: {
  readonly connectedProviderIds: ReadonlyArray<string>;
  readonly knownProviders: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly authMethodCount: number;
}) {
  if (input.connectedProviderIds.length === 0) {
    return input.authMethodCount > 0
      ? {
          auth: { status: "unauthenticated" as const },
          message:
            "OpenCode server bridge is healthy, but no upstream providers are authenticated. Connect a provider in OpenCode and try again.",
        }
      : {
          auth: { status: "unknown" as const },
          message:
            "OpenCode server bridge is healthy, but provider authentication could not be verified.",
        };
  }

  const knownProviders = new Map(
    input.knownProviders.map((provider) => [provider.id, provider.name]),
  );
  const labels = input.connectedProviderIds.map(
    (providerId) => knownProviders.get(providerId) ?? providerId,
  );
  const label = labels.length === 1 ? labels[0] : `${labels.length} providers connected`;

  return {
    auth: {
      status: "authenticated" as const,
      label,
      ...(labels.length === 1 ? { type: input.connectedProviderIds[0] } : {}),
    },
    message:
      labels.length === 1
        ? `OpenCode server bridge is healthy and ${label} is connected.`
        : `OpenCode server bridge is healthy and ${label}.`,
  };
}

export const checkOpencodeProviderStatus = Effect.gen(function* () {
  const opencodeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.opencode),
  );
  const opencodeServerManager = yield* OpencodeServerManager;
  const checkedAt = new Date().toISOString();
  const fallbackModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    opencodeSettings.customModels,
  );

  if (!opencodeSettings.enabled) {
    yield* opencodeServerManager.stop;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  const probeResult = yield* opencodeServerManager
    .probe({
      binaryPath: opencodeSettings.binaryPath,
    })
    .pipe(Effect.result);

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
          : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  const probe = probeResult.success;
  const authResolution = resolveOpenCodeAuth({
    connectedProviderIds: probe.connectedProviderIds,
    knownProviders: probe.knownProviders,
    authMethodCount: Object.values(probe.authMethodsByProviderId).reduce(
      (count, methods) => count + methods.length,
      0,
    ),
  });
  const models =
    probe.configuredProviders.length > 0
      ? resolveOpencodeModels({
          configuredProviders: probe.configuredProviders,
          customModels: opencodeSettings.customModels,
        })
      : fallbackModels;

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: probe.server.version,
      status: "ready",
      auth: authResolution.auth,
      message: authResolution.message,
    },
  });
});

export const OpencodeProviderLive = Layer.effect(
  OpencodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const opencodeServerManager = yield* OpencodeServerManager;

    const checkProvider = checkOpencodeProviderStatus.pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(OpencodeServerManager, opencodeServerManager),
    );

    return yield* makeManagedServerProvider<OpencodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
).pipe(Layer.provideMerge(OpencodeServerManagerLive));
