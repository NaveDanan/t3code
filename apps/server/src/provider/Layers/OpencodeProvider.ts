import type {
  ModelCapabilities,
  OpencodeSettings,
  ServerProviderModel,
  UpstreamProvider,
} from "@t3tools/contracts";
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
const OPENCODE_RUNTIME_CAPABILITIES = {
  busyFollowupMode: "native-steer" as const,
};

const DEFAULT_OPENCODE_REASONING_VARIANTS = ["low", "medium", "high"] as const;

function formatOpencodeEffortLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "minimal":
      return "Minimal";
    case "none":
      return "None";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function buildOpencodeReasoningCapabilities(
  variants: ReadonlyArray<string> = DEFAULT_OPENCODE_REASONING_VARIANTS,
): ModelCapabilities {
  const normalizedVariants = variants
    .map((variant) => variant.trim())
    .filter((variant, index, values) => variant.length > 0 && values.indexOf(variant) === index);
  const effectiveVariants =
    normalizedVariants.length > 0 ? normalizedVariants : [...DEFAULT_OPENCODE_REASONING_VARIANTS];

  return {
    reasoningEffortLevels: effectiveVariants.map((variant) => {
      const option: { value: string; label: string; isDefault?: true } = {
        value: variant,
        label: formatOpencodeEffortLabel(variant),
      };
      if (variant === "medium") {
        option.isDefault = true;
      }
      return option;
    }),
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

const OPENCODE_REASONING_CAPABILITIES: ModelCapabilities = buildOpencodeReasoningCapabilities();

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function resolveOpencodeReasoningVariants(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly variants?: Readonly<Record<string, unknown>>;
}): ReadonlyArray<string> {
  const configuredVariants = input.variants ? Object.keys(input.variants) : [];
  if (configuredVariants.length > 0) {
    return configuredVariants;
  }
  if (input.providerId === "openai" && input.modelId.startsWith("gpt-5")) {
    return DEFAULT_OPENCODE_REASONING_VARIANTS;
  }
  return [];
}

function resolveOpencodeModelCapabilities(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly supportsReasoning: boolean;
  readonly variants?: Readonly<Record<string, unknown>>;
}): ModelCapabilities | null {
  if (!input.supportsReasoning) {
    return null;
  }

  return buildOpencodeReasoningCapabilities(resolveOpencodeReasoningVariants(input));
}

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "openai/gpt-5",
    name: "OpenAI GPT-5",
    isCustom: false,
    capabilities: OPENCODE_REASONING_CAPABILITIES,
  },
  {
    slug: "openai/gpt-5-mini",
    name: "OpenAI GPT-5 Mini",
    isCustom: false,
    capabilities: OPENCODE_REASONING_CAPABILITIES,
  },
];

function resolveOpencodeModels(input: {
  readonly customModels: ReadonlyArray<string>;
  readonly configuredProviders: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly models: Readonly<
      Record<
        string,
        {
          readonly id: string;
          readonly name: string;
          readonly capabilities?: {
            readonly reasoning?: boolean;
          };
          readonly variants?: Readonly<Record<string, unknown>>;
        }
      >
    >;
  }>;
}): ReadonlyArray<ServerProviderModel> {
  const discoveredModels = input.configuredProviders
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        slug: `${provider.id}/${model.id}`,
        name: `${provider.name} ${model.name}`,
        isCustom: false,
        capabilities: resolveOpencodeModelCapabilities({
          providerId: provider.id,
          modelId: model.id,
          supportsReasoning: model.capabilities?.reasoning === true,
          ...(model.variants ? { variants: model.variants } : {}),
        }),
      })),
    )
    .toSorted((left, right) => left.slug.localeCompare(right.slug));

  return providerModelsFromSettings(
    discoveredModels,
    PROVIDER,
    input.customModels,
    EMPTY_CAPABILITIES,
  );
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

function resolveUpstreamProviders(input: {
  readonly knownProviders: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly connectedProviderIds: ReadonlyArray<string>;
  readonly authMethodsByProviderId: Readonly<Record<string, ReadonlyArray<unknown>>>;
}): ReadonlyArray<UpstreamProvider> {
  const connectedSet = new Set(input.connectedProviderIds);
  return input.knownProviders
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      connected: connectedSet.has(provider.id),
      hasAuthMethods: (input.authMethodsByProviderId[provider.id]?.length ?? 0) > 0,
    }))
    .toSorted((left, right) => {
      if (left.connected !== right.connected) return left.connected ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
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
    EMPTY_CAPABILITIES,
  );

  if (!opencodeSettings.enabled) {
    yield* opencodeServerManager.stop;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      runtimeCapabilities: OPENCODE_RUNTIME_CAPABILITIES,
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
      runtimeCapabilities: OPENCODE_RUNTIME_CAPABILITIES,
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

  const upstreamProviders = resolveUpstreamProviders({
    knownProviders: probe.knownProviders,
    connectedProviderIds: probe.connectedProviderIds,
    authMethodsByProviderId: probe.authMethodsByProviderId,
  });

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    upstreamProviders,
    runtimeCapabilities: OPENCODE_RUNTIME_CAPABILITIES,
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
