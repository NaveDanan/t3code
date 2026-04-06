import type {
  ForgeCodeSettings,
  ForgeExecutionBackend,
  ModelCapabilities,
  ServerProviderExecutionBackend,
  ServerProviderModel,
  ServerProviderState,
  UpstreamProvider,
} from "@t3tools/contracts";
import { Data, Effect, Equal, Option, Result, Stream, Layer } from "effect";
import { runProcess } from "../../processRunner";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { ForgeProvider } from "../Services/ForgeProvider";
import { ServerSettingsService } from "../../serverSettings";
import {
  buildForgeModelSlug,
  buildForgeSpawnSpec,
  defaultForgeExecutionBackendForHost,
  discoverGitBashPath,
  forgeExecutionBackendLabel,
  parseDefaultWslDistro,
  parseForgeModelCatalogRows,
  parseForgeProviderCatalogRows,
  type ForgeExecutionTarget,
} from "../forgecode";

const PROVIDER = "forgecode" as const;

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

interface ForgeBackendProbeResult {
  readonly status: ServerProviderExecutionBackend;
  readonly executionTarget?: ForgeExecutionTarget;
}

class ForgeProviderProcessError extends Data.TaggedError("ForgeProviderProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type ForgeProviderProcessRunner = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string | undefined;
    readonly shell: boolean;
    readonly allowNonZeroExit?: boolean;
  },
) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}>;

let forgeProviderProcessRunner: ForgeProviderProcessRunner = (command, args, options) =>
  runProcess(command, args, options);

export function setForgeProviderProcessRunnerForTests(
  runner: ForgeProviderProcessRunner | null,
): void {
  forgeProviderProcessRunner =
    runner ?? ((command, args, options) => runProcess(command, args, options));
}

function buildBackendStatus(input: {
  readonly id: ForgeExecutionBackend;
  readonly available: boolean;
  readonly reason?: string;
}): ServerProviderExecutionBackend {
  return {
    id: input.id,
    label: forgeExecutionBackendLabel(input.id),
    available: input.available,
    isDefault: input.id === defaultForgeExecutionBackendForHost(),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function buildBuiltInModels(preferredProviderId?: string): ReadonlyArray<ServerProviderModel> {
  const slugs =
    preferredProviderId && preferredProviderId.trim().length > 0
      ? [
          {
            slug: buildForgeModelSlug(preferredProviderId, "gpt-5.4"),
            name: "GPT-5.4",
          },
          {
            slug: buildForgeModelSlug(preferredProviderId, "gpt-5.4-mini"),
            name: "GPT-5.4 Mini",
          },
        ]
      : [
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
          },
          {
            slug: "gpt-5.4-mini",
            name: "GPT-5.4 Mini",
          },
        ];

  return slugs.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  }));
}

function parseForgeModelRows(output: string): ReadonlyArray<ServerProviderModel> {
  return parseForgeModelCatalogRows(output)
    .map((row) => ({
      slug: buildForgeModelSlug(row.providerId, row.id),
      name: `${row.provider} ${row.model}`,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    }))
    .toSorted((left, right) => left.slug.localeCompare(right.slug));
}

function parseForgeProviderAuth(input: { readonly result: CommandResult }): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown";
    readonly label?: string;
    readonly type?: string;
  };
  readonly upstreamProviders: ReadonlyArray<UpstreamProvider>;
  readonly message?: string;
} {
  const rows = parseForgeProviderCatalogRows(input.result.stdout);
  if (rows.length === 0) {
    const detail = detailFromResult(input.result);
    return {
      status: input.result.code === 0 ? "warning" : "error",
      auth: { status: "unknown" },
      upstreamProviders: [],
      ...(detail ? { message: `Could not read Forge provider status. ${detail}` } : {}),
    };
  }

  const upstreamProviders = rows.map((row) => ({
    id: row.id,
    name: row.name,
    connected: row.loggedIn,
    hasAuthMethods: row.host !== "[empty]",
  }));
  const connectedProviders = upstreamProviders.filter((provider) => provider.connected);
  if (connectedProviders.length === 0) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      upstreamProviders,
      message:
        "ForgeCode CLI is available, but no upstream Forge providers are authenticated. Run `forge provider login` on the selected Forge backend and try again.",
    };
  }

  const label =
    connectedProviders.length === 1
      ? connectedProviders[0]!.name
      : `${connectedProviders.length} providers connected`;
  return {
    status: "ready",
    auth: {
      status: "authenticated",
      label,
      ...(connectedProviders.length === 1 ? { type: connectedProviders[0]!.id } : {}),
    },
    upstreamProviders,
    message:
      connectedProviders.length === 1
        ? `ForgeCode CLI is available and ${label} is connected.`
        : `ForgeCode CLI is available and ${label}.`,
  };
}

const runSpec = Effect.fn("runSpec")(function* (input: {
  readonly label: string;
  readonly spec: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string | undefined;
    readonly shell: boolean;
  };
}) {
  return yield* Effect.tryPromise({
    try: () =>
      forgeProviderProcessRunner(input.spec.command, input.spec.args, {
        env: input.spec.env,
        cwd: input.spec.cwd,
        shell: input.spec.shell,
        allowNonZeroExit: true,
      }),
    catch: (cause) =>
      new ForgeProviderProcessError({
        message: `Failed to run ${input.label}.`,
        cause,
      }),
  }).pipe(
    Effect.map((result) => ({
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
    })),
  );
});

const probeNativeBackend = Effect.fn("probeNativeBackend")(function* (): Effect.fn.Return<
  ForgeBackendProbeResult,
  never
> {
  const result = yield* runSpec({
    label: "zsh",
    spec: {
      command: "zsh",
      args: ["-i", "-l", "-c", "command -v zsh"],
      env: process.env,
      cwd: undefined,
      shell: false,
    },
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(result)) {
    return {
      status: buildBackendStatus({
        id: "native",
        available: false,
        reason: isCommandMissingCause(result.failure)
          ? "zsh is not installed on this machine."
          : `Failed to verify zsh for the Native backend: ${result.failure instanceof Error ? result.failure.message : String(result.failure)}.`,
      }),
    };
  }
  if (Option.isNone(result.success)) {
    return {
      status: buildBackendStatus({
        id: "native",
        available: false,
        reason: "Timed out while verifying zsh for the Native backend.",
      }),
    };
  }

  if (result.success.value.code !== 0 || result.success.value.stdout.trim().length === 0) {
    return {
      status: buildBackendStatus({
        id: "native",
        available: false,
        reason: "zsh is not installed on this machine.",
      }),
    };
  }

  return {
    status: buildBackendStatus({ id: "native", available: true }),
    executionTarget: { executionBackend: "native" },
  };
});

const probeGitBashBackend = Effect.fn("probeGitBashBackend")(function* (): Effect.fn.Return<
  ForgeBackendProbeResult,
  never
> {
  const gitBashPath = discoverGitBashPath();
  if (!gitBashPath) {
    return {
      status: buildBackendStatus({
        id: "gitbash",
        available: false,
        reason: "Git Bash could not be discovered from the installed Git for Windows paths.",
      }),
    };
  }

  const result = yield* runSpec({
    label: gitBashPath,
    spec: {
      command: gitBashPath,
      args: ["-lc", "command -v zsh"],
      env: process.env,
      cwd: undefined,
      shell: false,
    },
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(result)) {
    return {
      status: buildBackendStatus({
        id: "gitbash",
        available: false,
        reason: `Failed to verify zsh for Git Bash: ${result.failure instanceof Error ? result.failure.message : String(result.failure)}.`,
      }),
    };
  }
  if (Option.isNone(result.success)) {
    return {
      status: buildBackendStatus({
        id: "gitbash",
        available: false,
        reason: "Timed out while verifying zsh for Git Bash.",
      }),
    };
  }

  if (result.success.value.code !== 0 || result.success.value.stdout.trim().length === 0) {
    return {
      status: buildBackendStatus({
        id: "gitbash",
        available: false,
        reason: "zsh is not installed in Git Bash.",
      }),
    };
  }

  return {
    status: buildBackendStatus({ id: "gitbash", available: true }),
    executionTarget: {
      executionBackend: "gitbash",
      gitBashPath,
    },
  };
});

const probeWslBackend = Effect.fn("probeWslBackend")(function* (): Effect.fn.Return<
  ForgeBackendProbeResult,
  never
> {
  const statusResult = yield* runSpec({
    label: "wsl.exe",
    spec: {
      command: "wsl.exe",
      args: ["--status"],
      env: process.env,
      cwd: undefined,
      shell: false,
    },
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(statusResult)) {
    return {
      status: buildBackendStatus({
        id: "wsl",
        available: false,
        reason: isCommandMissingCause(statusResult.failure)
          ? "WSL is not installed or wsl.exe is not available."
          : `Failed to query WSL status: ${statusResult.failure instanceof Error ? statusResult.failure.message : String(statusResult.failure)}.`,
      }),
    };
  }
  if (Option.isNone(statusResult.success)) {
    return {
      status: buildBackendStatus({
        id: "wsl",
        available: false,
        reason: "Timed out while querying WSL status.",
      }),
    };
  }

  if (statusResult.success.value.code !== 0) {
    return {
      status: buildBackendStatus({
        id: "wsl",
        available: false,
        reason:
          detailFromResult(statusResult.success.value) ??
          "WSL is installed but no default distro is configured.",
      }),
    };
  }

  const wslDistro = parseDefaultWslDistro(
    `${statusResult.success.value.stdout}\n${statusResult.success.value.stderr}`,
  );
  let resolvedWslDistro = wslDistro;
  if (!resolvedWslDistro) {
    resolvedWslDistro = yield* runSpec({
      label: "wsl.exe",
      spec: {
        command: "wsl.exe",
        args: ["-l", "-v"],
        env: process.env,
        cwd: undefined,
        shell: false,
      },
    }).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.map((result) =>
        Option.match(result, {
          onNone: () => undefined,
          onSome: (value) => parseDefaultWslDistro(`${value.stdout}\n${value.stderr}`),
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
  }
  if (!resolvedWslDistro) {
    return {
      status: buildBackendStatus({
        id: "wsl",
        available: false,
        reason: "WSL is installed but no default distro is configured.",
      }),
    };
  }

  const zshResult = yield* runSpec({
    label: "wsl.exe",
    spec: {
      command: "wsl.exe",
      args: ["--distribution", resolvedWslDistro, "sh", "-lc", "command -v zsh"],
      env: process.env,
      cwd: undefined,
      shell: false,
    },
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(zshResult)) {
    return {
      status: buildBackendStatus({
        id: "wsl",
        available: false,
        reason: `Failed to verify zsh in the WSL distro '${resolvedWslDistro}': ${zshResult.failure instanceof Error ? zshResult.failure.message : String(zshResult.failure)}.`,
      }),
    };
  }
  if (Option.isNone(zshResult.success)) {
    return {
      status: buildBackendStatus({
        id: "wsl",
        available: false,
        reason: `Timed out while verifying zsh in the WSL distro '${resolvedWslDistro}'.`,
      }),
    };
  }

  if (zshResult.success.value.code !== 0 || zshResult.success.value.stdout.trim().length === 0) {
    return {
      status: buildBackendStatus({
        id: "wsl",
        available: false,
        reason: `zsh is not installed in the default WSL distro '${resolvedWslDistro}'.`,
      }),
    };
  }

  return {
    status: buildBackendStatus({ id: "wsl", available: true }),
    executionTarget: {
      executionBackend: "wsl",
      wslDistro: resolvedWslDistro,
    },
  };
});

const probeExecutionBackends = Effect.fn("probeExecutionBackends")(function* (): Effect.fn.Return<
  ReadonlyArray<ForgeBackendProbeResult>,
  never
> {
  if (process.platform === "win32") {
    return yield* Effect.all([probeWslBackend(), probeGitBashBackend()], {
      concurrency: "unbounded",
    });
  }
  return yield* Effect.all([probeNativeBackend()], {
    concurrency: "unbounded",
  });
});

const runForgeCommand = Effect.fn("runForgeCommand")(function* (input: {
  readonly binaryPath: string;
  readonly executionTarget: ForgeExecutionTarget;
  readonly cwd?: string;
  readonly args: ReadonlyArray<string>;
}) {
  const spec = buildForgeSpawnSpec({
    binaryPath: input.binaryPath,
    forgeArgs: input.args,
    executionTarget: input.executionTarget,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  return yield* Effect.tryPromise({
    try: () =>
      forgeProviderProcessRunner(spec.command, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        shell: spec.shell,
      }),
    catch: (cause) =>
      new ForgeProviderProcessError({
        message: `Failed to run ${input.binaryPath}.`,
        cause,
      }),
  }).pipe(
    Effect.map((result) => ({
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
    })),
  );
});

function fallbackModelsFromSettings(
  forgeSettings: ForgeCodeSettings,
  preferredProviderId?: string,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    buildBuiltInModels(preferredProviderId),
    PROVIDER,
    forgeSettings.customModels,
  );
}

export const checkForgeProviderStatus = Effect.gen(function* () {
  const forgeSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.forgecode),
  );
  const checkedAt = new Date().toISOString();
  const backendProbes = yield* probeExecutionBackends();
  const executionBackends = backendProbes.map((probe) => probe.status);
  const fallbackModels = fallbackModelsFromSettings(forgeSettings);

  if (!forgeSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      executionBackends,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ForgeCode is disabled in T3 Code settings.",
      },
    });
  }

  const selectedBackend =
    backendProbes.find((probe) => probe.status.id === forgeSettings.executionBackend) ?? null;
  if (!selectedBackend) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      executionBackends,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `ForgeCode backend '${forgeSettings.executionBackend}' is not supported on this host.`,
      },
    });
  }

  if (!selectedBackend.status.available || !selectedBackend.executionTarget) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      executionBackends,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          selectedBackend.status.reason ??
          `ForgeCode backend '${selectedBackend.status.label}' is unavailable.`,
      },
    });
  }

  const versionResult = yield* runForgeCommand({
    binaryPath: forgeSettings.binaryPath,
    executionTarget: selectedBackend.executionTarget,
    args: ["--version"],
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      executionBackends,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? `ForgeCode CLI is not available on the selected ${selectedBackend.status.label} backend. Confirm zsh is installed and the Forge binary path is correct.`
          : `Failed to execute the ForgeCode CLI on ${selectedBackend.status.label}: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      executionBackends,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `ForgeCode CLI is available on ${selectedBackend.status.label} but timed out during the health check.`,
      },
    });
  }

  const version = parseGenericCliVersion(
    versionResult.success.value.stdout || versionResult.success.value.stderr,
  );
  const [providerResult, modelResult] = yield* Effect.all(
    [
      runForgeCommand({
        binaryPath: forgeSettings.binaryPath,
        executionTarget: selectedBackend.executionTarget,
        args: ["provider", "list", "--porcelain"],
      }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result),
      runForgeCommand({
        binaryPath: forgeSettings.binaryPath,
        executionTarget: selectedBackend.executionTarget,
        args: ["list", "model", "--porcelain"],
      }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result),
    ],
    { concurrency: "unbounded" },
  );

  const authResolution = Result.isFailure(providerResult)
    ? {
        status: "warning" as const,
        auth: { status: "unknown" as const },
        upstreamProviders: [] as const,
        message: `Could not read Forge providers: ${providerResult.failure instanceof Error ? providerResult.failure.message : String(providerResult.failure)}.`,
      }
    : Option.isNone(providerResult.success)
      ? {
          status: "warning" as const,
          auth: { status: "unknown" as const },
          upstreamProviders: [] as const,
          message: "Could not read Forge providers. Timed out while running command.",
        }
      : parseForgeProviderAuth({ result: providerResult.success.value });

  const dynamicFallbackModels = fallbackModelsFromSettings(
    forgeSettings,
    authResolution.upstreamProviders.filter((provider) => provider.connected).length === 1
      ? authResolution.upstreamProviders.find((provider) => provider.connected)?.id
      : undefined,
  );
  const modelCatalogWarning = Result.isFailure(modelResult)
    ? `Could not read Forge models: ${modelResult.failure instanceof Error ? modelResult.failure.message : String(modelResult.failure)}.`
    : Option.isNone(modelResult.success)
      ? "Could not read Forge models. Timed out while running command."
      : undefined;
  const discoveredModels =
    Result.isSuccess(modelResult) && Option.isSome(modelResult.success)
      ? parseForgeModelRows(modelResult.success.value.stdout)
      : [];
  const models =
    discoveredModels.length > 0
      ? providerModelsFromSettings(discoveredModels, PROVIDER, forgeSettings.customModels)
      : dynamicFallbackModels;
  const messageParts = [authResolution.message, modelCatalogWarning].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  const status =
    authResolution.status === "ready" && modelCatalogWarning !== undefined
      ? "warning"
      : authResolution.status;

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    executionBackends,
    upstreamProviders: authResolution.upstreamProviders,
    probe: {
      installed: true,
      version,
      status,
      auth: authResolution.auth,
      ...(messageParts.length > 0 ? { message: messageParts.join(" ") } : {}),
    },
  });
});

export const ForgeProviderLive = Layer.effect(
  ForgeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    const checkProvider = checkForgeProviderStatus.pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
    );

    return yield* makeManagedServerProvider<ForgeCodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.forgecode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.forgecode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
