/**
 * CursorProviderLive – Provider snapshot layer for the Cursor headless CLI.
 *
 * Probes `cursor-agent --version` on the selected execution backend (native
 * or WSL), reports installation/auth status, and exposes the built-in
 * `auto` model plus any user-configured custom models.
 *
 * @module CursorProviderLive
 */
import type {
  CursorAgentExecutionBackend,
  CursorAgentSettings,
  ServerProviderExecutionBackend,
  ServerProviderState,
} from "@t3tools/contracts";
import { Data, Effect, Equal, Layer, Option, Result, Stream } from "effect";

import { runProcess } from "../../processRunner";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { CursorProvider } from "../Services/CursorProvider";
import { ServerSettingsService } from "../../serverSettings";
import {
  buildCursorSpawnSpec,
  cursorExecutionBackendLabel,
  defaultCursorExecutionBackendForHost,
  parseCursorAgentModelsOutput,
  resolveCursorAgentModels,
  supportedCursorExecutionBackends,
  type CursorExecutionTarget,
} from "../cursorAgent";
import { parseDefaultWslDistro } from "../forgecode";

const PROVIDER = "cursorAgent" as const;

interface CursorBackendProbeResult {
  readonly status: ServerProviderExecutionBackend;
  readonly executionTarget?: CursorExecutionTarget;
}

class CursorProviderProcessError extends Data.TaggedError("CursorProviderProcessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type CursorProviderProcessRunner = (
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

let cursorProviderProcessRunner: CursorProviderProcessRunner = (command, args, options) =>
  runProcess(command, args, options);

export function setCursorProviderProcessRunnerForTests(
  runner: CursorProviderProcessRunner | null,
): void {
  cursorProviderProcessRunner =
    runner ?? ((command, args, options) => runProcess(command, args, options));
}

function buildBackendStatus(input: {
  readonly id: CursorAgentExecutionBackend;
  readonly available: boolean;
  readonly reason?: string;
}): ServerProviderExecutionBackend {
  return {
    id: input.id,
    label: cursorExecutionBackendLabel(input.id),
    available: input.available,
    isDefault: input.id === defaultCursorExecutionBackendForHost(),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function buildExecutionBackends(
  selectedProbe?: CursorBackendProbeResult | null,
): ReadonlyArray<ServerProviderExecutionBackend> {
  return supportedCursorExecutionBackends().map((backend) =>
    selectedProbe?.status.id === backend
      ? selectedProbe.status
      : buildBackendStatus({ id: backend, available: true }),
  );
}

// ── Backend probing ───────────────────────────────────────────────────

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
      cursorProviderProcessRunner(input.spec.command, input.spec.args, {
        env: input.spec.env,
        cwd: input.spec.cwd,
        shell: input.spec.shell,
        allowNonZeroExit: true,
      }),
    catch: (cause) =>
      new CursorProviderProcessError({
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
  CursorBackendProbeResult,
  never
> {
  // On native, cursor-agent should be directly available on PATH.
  // Yield to satisfy generator function requirement.
  yield* Effect.void;
  return {
    status: buildBackendStatus({ id: "native", available: true }),
    executionTarget: { executionBackend: "native" },
  };
});

const probeWslBackend = Effect.fn("probeWslBackend")(function* (): Effect.fn.Return<
  CursorBackendProbeResult,
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

  return {
    status: buildBackendStatus({ id: "wsl", available: true }),
    executionTarget: {
      executionBackend: "wsl",
      wslDistro: resolvedWslDistro,
    },
  };
});

const probeSelectedBackend = Effect.fn("probeSelectedBackend")(function* (
  executionBackend: CursorAgentExecutionBackend,
): Effect.fn.Return<CursorBackendProbeResult | null, never> {
  switch (executionBackend) {
    case "native":
      return yield* probeNativeBackend();
    case "wsl":
      return process.platform === "win32" ? yield* probeWslBackend() : null;
  }
});

const runCursorCommand = Effect.fn("runCursorCommand")(function* (input: {
  readonly binaryPath: string;
  readonly executionTarget: CursorExecutionTarget;
  readonly args: ReadonlyArray<string>;
}) {
  const spec = buildCursorSpawnSpec({
    binaryPath: input.binaryPath,
    cursorArgs: input.args,
    executionTarget: input.executionTarget,
  });
  return yield* Effect.tryPromise({
    try: () =>
      cursorProviderProcessRunner(spec.command, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        shell: spec.shell,
      }),
    catch: (cause) =>
      new CursorProviderProcessError({
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

// ── Provider status check ─────────────────────────────────────────────

export const checkCursorProviderStatus = Effect.gen(function* () {
  const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.cursorAgent),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = resolveCursorAgentModels(cursorSettings);

  if (!cursorSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      executionBackends: buildExecutionBackends(),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in NJ Code settings.",
      },
    });
  }

  const selectedBackend = yield* probeSelectedBackend(cursorSettings.executionBackend);
  const executionBackends = buildExecutionBackends(selectedBackend);
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
        message: `Cursor backend '${cursorSettings.executionBackend}' is not supported on this host.`,
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
          `Cursor backend '${selectedBackend.status.label}' is unavailable.`,
      },
    });
  }

  const versionResult = yield* runCursorCommand({
    binaryPath: cursorSettings.binaryPath,
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
          ? `Cursor CLI is not available on the selected ${selectedBackend.status.label} backend. Confirm the backend is installed and the cursor-agent binary path is correct.`
          : `Failed to execute the Cursor CLI on ${selectedBackend.status.label}: ${error instanceof Error ? error.message : String(error)}.`,
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
        message: `Cursor CLI is available on ${selectedBackend.status.label} but timed out during the health check.`,
      },
    });
  }

  const version = parseGenericCliVersion(
    versionResult.success.value.stdout || versionResult.success.value.stderr,
  );
  const discoveredModelsResult = yield* runCursorCommand({
    binaryPath: cursorSettings.binaryPath,
    executionTarget: selectedBackend.executionTarget,
    args: ["models"],
  }).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
  const models =
    Result.isSuccess(discoveredModelsResult) && Option.isSome(discoveredModelsResult.success)
      ? resolveCursorAgentModels(
          cursorSettings,
          parseCursorAgentModelsOutput(
            `${discoveredModelsResult.success.value.stdout}\n${discoveredModelsResult.success.value.stderr}`,
          ),
        )
      : fallbackModels;

  // Auth is unknown until first run — Cursor does not expose an auth probe.
  const status: Exclude<ServerProviderState, "disabled"> =
    versionResult.success.value.code === 0 ? "ready" : "error";
  const message =
    versionResult.success.value.code === 0
      ? `Cursor CLI${version ? ` v${version}` : ""} is available on ${selectedBackend.status.label}.`
      : `Cursor CLI exited with code ${versionResult.success.value.code} during version probe.`;

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    executionBackends,
    probe: {
      installed: true,
      version,
      status,
      auth: { status: "unknown" },
      message,
    },
  });
});

// ── Layer ─────────────────────────────────────────────────────────────

export const CursorProviderLive = Layer.effect(
  CursorProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    const checkProvider = checkCursorProviderStatus.pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
    );

    return yield* makeManagedServerProvider<CursorAgentSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.cursorAgent),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.cursorAgent),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
