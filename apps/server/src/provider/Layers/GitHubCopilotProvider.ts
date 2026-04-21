/**
 * GitHubCopilotProviderLive – Provider snapshot layer for GitHub Copilot.
 *
 * Uses the Copilot CLI binary for installation/version probing, then asks the
 * Copilot runtime for live auth and model information via the Copilot SDK.
 * This matches real CLI behavior even when credentials live in the OS keychain
 * or come from environment variables.
 *
 * @module GitHubCopilotProviderLive
 */
import { CopilotClient, type GetAuthStatusResponse, type ModelInfo } from "@github/copilot-sdk";
import type {
  GitHubCopilotSettings,
  HarnessUpdateResult,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Data, Effect, Equal, Layer, Result, Stream } from "effect";
import { existsSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join } from "node:path";
import { isWindowsCommandNotFound, runProcess } from "../../processRunner";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { GitHubCopilotProvider } from "../Services/GitHubCopilotProvider";
import { ServerSettingsService } from "../../serverSettings";
import {
  buildGitHubCopilotReasoningCapabilities,
  GITHUB_COPILOT_EMPTY_CAPABILITIES,
  normalizeAuthStatus,
  resolveGitHubCopilotModels,
} from "../githubCopilot";

const PROVIDER = "githubCopilot" as const;
const DEFAULT_TIMEOUT_MS = 4_000;

const GITHUB_COPILOT_RUNTIME_CAPABILITIES = {
  busyFollowupMode: "native-steer" as const,
};

class GitHubCopilotProviderProbeError extends Data.TaggedError("GitHubCopilotProviderProbeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type GitHubCopilotProcessRunner = (
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

let ghCopilotProcessRunner: GitHubCopilotProcessRunner = (command, args, options) =>
  runProcess(command, args, options);

interface GitHubCopilotRuntimeProbeResult {
  readonly auth: GetAuthStatusResponse;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

type GitHubCopilotRuntimeProbe = (binaryPath: string) => Promise<GitHubCopilotRuntimeProbeResult>;

interface GitHubCopilotSdkLaunchConfig {
  readonly cliPath?: string;
  readonly cliArgs?: string[];
}

function shouldUseBundledSdkCli(binaryPath: string): boolean {
  const normalized = binaryPath.trim().toLowerCase();
  if (normalized.length === 0 || normalized === "copilot") {
    return true;
  }
  if (process.platform !== "win32") {
    return false;
  }
  return (
    normalized.endsWith(".cmd") ||
    normalized.endsWith(".bat") ||
    normalized.endsWith(".ps1") ||
    normalized.endsWith(".js") ||
    normalized.endsWith("/copilot") ||
    normalized.endsWith("\\copilot")
  );
}

function isElectronNodeRuntime(): boolean {
  return Boolean(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1");
}

function findExecutableOnPath(
  executableNames: ReadonlyArray<string>,
  pathValue: string | undefined,
): string | undefined {
  if (!pathValue) {
    return undefined;
  }

  const seen = new Set<string>();
  for (const rawEntry of pathValue.split(delimiter)) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }

    for (const executableName of executableNames) {
      const candidate = join(entry, executableName);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function resolveExecutableNamesForPlatform(
  binaryPath: string,
  options?: {
    readonly platform?: NodeJS.Platform;
    readonly pathExt?: string | undefined;
  },
): ReadonlyArray<string> {
  const trimmedBinaryPath = binaryPath.trim();
  if (trimmedBinaryPath.length === 0) {
    return [];
  }

  const platform = options?.platform ?? process.platform;
  if (platform !== "win32") {
    return [trimmedBinaryPath];
  }

  if (extname(trimmedBinaryPath).length > 0) {
    return [trimmedBinaryPath];
  }

  const pathExtValue = options?.pathExt ?? process.env.PATHEXT;
  const extensions = (pathExtValue || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  return [trimmedBinaryPath, ...extensions.map((extension) => `${trimmedBinaryPath}${extension}`)];
}

function resolveCliPathForSdk(
  binaryPath: string,
  options?: {
    readonly pathValue?: string;
    readonly platform?: NodeJS.Platform;
    readonly pathExt?: string | undefined;
  },
): string | undefined {
  const trimmedBinaryPath = binaryPath.trim();
  if (trimmedBinaryPath.length === 0) {
    return undefined;
  }

  if (
    isAbsolute(trimmedBinaryPath) ||
    trimmedBinaryPath.includes("/") ||
    trimmedBinaryPath.includes("\\")
  ) {
    return existsSync(trimmedBinaryPath) ? trimmedBinaryPath : undefined;
  }

  return findExecutableOnPath(
    resolveExecutableNamesForPlatform(trimmedBinaryPath, options),
    options?.pathValue ?? process.env.PATH,
  );
}

export function resolveGitHubCopilotSdkLaunchConfig(
  binaryPath: string,
  options?: {
    readonly bundledCliPath?: string;
    readonly pathValue?: string;
    readonly platform?: NodeJS.Platform;
    readonly runningInElectron?: boolean;
  },
): GitHubCopilotSdkLaunchConfig {
  const platform = options?.platform ?? process.platform;
  const runningInElectron = options?.runningInElectron ?? isElectronNodeRuntime();
  const resolvedCliPath = resolveCliPathForSdk(binaryPath, {
    platform,
    ...(options?.pathValue !== undefined ? { pathValue: options.pathValue } : {}),
  });

  if (resolvedCliPath) {
    return { cliPath: resolvedCliPath };
  }

  if (!shouldUseBundledSdkCli(binaryPath)) {
    return { cliPath: binaryPath };
  }

  if (!runningInElectron || platform !== "win32") {
    return {};
  }

  const cliEntrypoint = options?.bundledCliPath?.trim() || binaryPath.trim();
  if (cliEntrypoint.length === 0 || basename(cliEntrypoint).toLowerCase() === "copilot") {
    return {};
  }

  const nodeExecPath = findExecutableOnPath(
    ["node.exe", "node"],
    options?.pathValue ?? process.env.PATH,
  );
  if (!nodeExecPath) {
    return {};
  }

  return {
    cliPath: nodeExecPath,
    cliArgs: [cliEntrypoint],
  };
}

function toServerProviderModel(model: ModelInfo): ServerProviderModel {
  const reasoningEfforts =
    model.supportedReasoningEfforts ??
    (model.capabilities.supports.reasoningEffort ? ["low", "medium", "high", "xhigh"] : []);

  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities:
      reasoningEfforts.length > 0
        ? buildGitHubCopilotReasoningCapabilities(reasoningEfforts, model.defaultReasoningEffort)
        : GITHUB_COPILOT_EMPTY_CAPABILITIES,
  };
}

function createGitHubCopilotClient(binaryPath: string): CopilotClient {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_AUTO_UPDATE: "false",
    NODE_NO_WARNINGS: "1",
  };

  if (!shouldUseBundledSdkCli(binaryPath)) {
    return new CopilotClient({
      cliPath: binaryPath,
      autoStart: false,
      logLevel: "none",
      env,
    });
  }

  const bundledClient = new CopilotClient({
    autoStart: false,
    logLevel: "none",
    env,
  });

  const bundledCliPath = (bundledClient as unknown as { options?: { readonly cliPath?: string } })
    .options?.cliPath;
  const launchConfig = resolveGitHubCopilotSdkLaunchConfig(binaryPath, {
    ...(bundledCliPath !== undefined ? { bundledCliPath } : {}),
    ...(env.PATH !== undefined ? { pathValue: env.PATH } : {}),
  });

  if (launchConfig.cliArgs && launchConfig.cliArgs.length > 0) {
    return new CopilotClient({
      ...(launchConfig.cliPath ? { cliPath: launchConfig.cliPath } : {}),
      cliArgs: [...launchConfig.cliArgs],
      autoStart: false,
      logLevel: "none",
      env,
    });
  }

  return bundledClient;
}

async function defaultGitHubCopilotRuntimeProbe(
  binaryPath: string,
): Promise<GitHubCopilotRuntimeProbeResult> {
  const client = createGitHubCopilotClient(binaryPath);

  try {
    await client.start();
    const [auth, models] = await Promise.all([client.getAuthStatus(), client.listModels()]);
    return {
      auth,
      models: models.map(toServerProviderModel),
    };
  } finally {
    try {
      await client.stop();
    } catch {
      await client.forceStop().catch(() => undefined);
    }
  }
}

let ghCopilotRuntimeProbe: GitHubCopilotRuntimeProbe = async (binaryPath) => {
  return defaultGitHubCopilotRuntimeProbe(binaryPath);
};

export function setGitHubCopilotProviderProcessRunnerForTests(
  runner: GitHubCopilotProcessRunner | null,
): void {
  ghCopilotProcessRunner =
    runner ?? ((command, args, options) => runProcess(command, args, options));
}

export function setGitHubCopilotProviderRuntimeProbeForTests(
  probe: GitHubCopilotRuntimeProbe | null,
): void {
  ghCopilotRuntimeProbe = probe ?? defaultGitHubCopilotRuntimeProbe;
}

function runCopilotCommand(
  binaryPath: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  { stdout: string; stderr: string; code: number },
  GitHubCopilotProviderProbeError
> {
  return Effect.tryPromise({
    try: () =>
      ghCopilotProcessRunner(binaryPath, [...args], {
        env: process.env,
        cwd: undefined,
        shell: process.platform === "win32",
        allowNonZeroExit: true,
      }),
    catch: (cause) =>
      new GitHubCopilotProviderProbeError({
        message:
          cause instanceof Error ? cause.message : `Failed to run ${binaryPath}: ${String(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.map((result) => ({
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
    })),
  );
}

export const checkGitHubCopilotProviderStatus = Effect.gen(function* () {
  const copilotSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.githubCopilot),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = resolveGitHubCopilotModels(copilotSettings);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      runtimeCapabilities: GITHUB_COPILOT_RUNTIME_CAPABILITIES,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in NJ Code settings.",
      },
    });
  }

  // Probe version
  const versionResult = yield* runCopilotCommand(copilotSettings.binaryPath, ["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      runtimeCapabilities: GITHUB_COPILOT_RUNTIME_CAPABILITIES,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : `Failed to execute GitHub Copilot CLI: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (versionResult.success._tag === "None") {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      runtimeCapabilities: GITHUB_COPILOT_RUNTIME_CAPABILITIES,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI is available but timed out during the health check.",
      },
    });
  }

  const versionOutput = versionResult.success.value;

  // On Windows with shell: true + allowNonZeroExit, cmd.exe exits 9009
  // when the command is not found instead of throwing ENOENT.
  if (isWindowsCommandNotFound(versionOutput.code, versionOutput.stderr)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      runtimeCapabilities: GITHUB_COPILOT_RUNTIME_CAPABILITIES,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "GitHub Copilot CLI (`copilot`) is not installed or not on PATH.",
      },
    });
  }

  const version = parseGenericCliVersion(versionOutput.stdout || versionOutput.stderr);

  const runtimeProbeResult = yield* Effect.tryPromise({
    try: () => ghCopilotRuntimeProbe(copilotSettings.binaryPath),
    catch: (cause) =>
      new GitHubCopilotProviderProbeError({
        message:
          cause instanceof Error
            ? cause.message
            : `Failed to probe GitHub Copilot runtime: ${String(cause)}`,
        cause,
      }),
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  const authResolution = Result.isFailure(runtimeProbeResult)
    ? normalizeAuthStatus({
        error: `Could not verify GitHub Copilot authentication status. ${runtimeProbeResult.failure.message}`,
      })
    : runtimeProbeResult.success._tag === "None"
      ? normalizeAuthStatus({
          error: "GitHub Copilot authentication check timed out.",
        })
      : normalizeAuthStatus({
          authenticated: runtimeProbeResult.success.value.auth.isAuthenticated,
          user: runtimeProbeResult.success.value.auth.login ?? null,
          authType: runtimeProbeResult.success.value.auth.authType ?? null,
          statusMessage: runtimeProbeResult.success.value.auth.statusMessage ?? null,
        });

  const discoveredModels =
    Result.isSuccess(runtimeProbeResult) && runtimeProbeResult.success._tag === "Some"
      ? runtimeProbeResult.success.value.models
      : [];
  const models = resolveGitHubCopilotModels(copilotSettings, discoveredModels);

  const isAuthed = authResolution.status === "authenticated";
  const statusForProvider = isAuthed
    ? "ready"
    : authResolution.status === "unauthenticated"
      ? "error"
      : "warning";
  const auth =
    authResolution.status === "authenticated"
      ? {
          status: "authenticated" as const,
          ...(authResolution.label ? { label: authResolution.label } : {}),
          ...(authResolution.type ? { type: authResolution.type } : {}),
        }
      : {
          status: authResolution.status as "unauthenticated" | "unknown",
          ...(authResolution.type ? { type: authResolution.type } : {}),
        };

  const messageParts = [authResolution.message].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    runtimeCapabilities: GITHUB_COPILOT_RUNTIME_CAPABILITIES,
    probe: {
      installed: true,
      version,
      status: statusForProvider,
      auth,
      ...(messageParts.length > 0 ? { message: messageParts.join(" ") } : {}),
    },
  });
});

export const GitHubCopilotProviderLive = Layer.effect(
  GitHubCopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    const checkProvider = checkGitHubCopilotProviderStatus.pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
    );

    const updateProvider = Effect.gen(function* () {
      const copilotSettings = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.githubCopilot),
      );
      const result = yield* runCopilotCommand(copilotSettings.binaryPath, ["update"]).pipe(
        Effect.timeout("120 seconds"),
      );
      return {
        provider: "githubCopilot" as const,
        success: result.code === 0,
        message:
          result.code === 0
            ? result.stdout.trim() || "Update completed."
            : result.stderr.trim() || result.stdout.trim() || `Exited with code ${result.code}.`,
      } satisfies HarnessUpdateResult;
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          provider: "githubCopilot" as const,
          success: false,
          message: "Update command failed.",
        }),
      ),
    );

    return yield* makeManagedServerProvider<GitHubCopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.githubCopilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.githubCopilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      updateProvider,
    });
  }),
);
