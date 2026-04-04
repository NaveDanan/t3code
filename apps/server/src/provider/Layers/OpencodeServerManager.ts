import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";

import {
  createOpencodeClient,
  type ConfigProvidersResponse,
  type GlobalHealthResponse,
  type OpencodeClient,
  type ProviderAuthMethod,
  type ProviderAuthResponse,
  type ProviderListResponse,
} from "@opencode-ai/sdk/v2";
import { Effect, Ref, Result } from "effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import {
  OpencodeServerManager,
  OpencodeServerManagerError,
  type OpencodeConfiguredProvider,
  type OpencodeKnownProvider,
  type OpencodeServerHandle,
  type OpencodeServerManagerShape,
} from "../Services/OpencodeServerManager";

const HOSTNAME = "127.0.0.1" as const;
const SERVER_START_TIMEOUT_MS = 5_000;
const HEALTH_CHECK_TIMEOUT_MS = 1_000;
const HEALTH_CHECK_INTERVAL_MS = 100;
const LOG_BUFFER_MAX_CHARS = 8_000;

interface OpencodeServerProcess {
  readonly pid?: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface ManagedServerState extends OpencodeServerHandle {
  readonly close: () => void;
  readonly isExited: () => boolean;
  readonly describeFailure: () => string | null;
  readonly refreshHealth: () => Promise<GlobalHealthResponse>;
  readonly probeMetadata: () => Promise<{
    configuredProviders: ReadonlyArray<OpencodeConfiguredProvider>;
    knownProviders: ReadonlyArray<OpencodeKnownProvider>;
    connectedProviderIds: ReadonlyArray<string>;
    authMethodsByProviderId: Readonly<Record<string, ReadonlyArray<ProviderAuthMethod>>>;
    defaultModelByProviderId: Readonly<Record<string, string>>;
  }>;
}

type SpawnServer = (input: {
  readonly binaryPath: string;
  readonly hostname: string;
  readonly port: number;
}) => OpencodeServerProcess;

type CreateClient = (input: { readonly url: string }) => OpencodeClient;
type PickPort = (hostname: string) => Promise<number>;

interface OpencodeServerManagerDependencies {
  readonly spawnServer?: SpawnServer;
  readonly createClient?: CreateClient;
  readonly pickPort?: PickPort;
  readonly startTimeoutMs?: number;
  readonly healthCheckTimeoutMs?: number;
  readonly healthCheckIntervalMs?: number;
}

function toManagerError(operation: string, error: unknown): OpencodeServerManagerError {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "OpencodeServerManagerError"
  ) {
    return error as OpencodeServerManagerError;
  }

  return new OpencodeServerManagerError({
    operation,
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

function appendLogBuffer(buffer: string, chunk: Buffer | string): string {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  const next = `${buffer}${text}`;
  if (next.length <= LOG_BUFFER_MAX_CHARS) {
    return next;
  }
  return next.slice(-LOG_BUFFER_MAX_CHARS);
}

function killServerProcess(process: OpencodeServerProcess): void {
  if (globalThis.process.platform === "win32" && process.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  process.kill("SIGTERM");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pickAvailablePort(hostname: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve an ephemeral OpenCode port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function createLiveServerProcess(input: {
  readonly binaryPath: string;
  readonly hostname: string;
  readonly port: number;
}): OpencodeServerProcess {
  return spawn(
    input.binaryPath,
    ["serve", `--hostname=${input.hostname}`, `--port=${input.port}`],
    {
      shell: globalThis.process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

function createLiveClient(input: { readonly url: string }): OpencodeClient {
  return createOpencodeClient({ baseUrl: input.url });
}

async function readSdkData<T>(request: Promise<unknown>, operation: string): Promise<T> {
  const result = (await request) as {
    data?: T;
    error?: unknown;
    response?: Response;
  };

  if (result.data !== undefined) {
    return result.data;
  }

  if (result.error instanceof Error) {
    throw result.error;
  }

  if (result.error !== undefined) {
    throw new Error(
      `${operation} failed: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error)}`,
    );
  }

  const status = result.response?.status;
  throw new Error(
    status ? `${operation} failed with HTTP ${status}.` : `${operation} returned no data.`,
  );
}

async function waitForHealthy(input: {
  readonly state: ManagedServerState;
  readonly startTimeoutMs: number;
  readonly healthCheckIntervalMs: number;
}): Promise<GlobalHealthResponse> {
  const startedAt = Date.now();
  let lastError: unknown = undefined;

  while (Date.now() - startedAt < input.startTimeoutMs) {
    const failure = input.state.describeFailure();
    if (failure) {
      throw new Error(failure);
    }

    try {
      return await input.state.refreshHealth();
    } catch (error) {
      lastError = error;
    }

    await delay(input.healthCheckIntervalMs);
  }

  const detail =
    lastError instanceof Error
      ? ` ${lastError.message}`
      : lastError !== undefined
        ? ` ${String(lastError)}`
        : "";
  throw new Error(`Timed out waiting for OpenCode server health.${detail}`);
}

async function startManagedServer(input: {
  readonly binaryPath: string;
  readonly spawnServer: SpawnServer;
  readonly createClient: CreateClient;
  readonly pickPort: PickPort;
  readonly startTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly healthCheckIntervalMs: number;
}): Promise<ManagedServerState> {
  const port = await input.pickPort(HOSTNAME);
  const url = `http://${HOSTNAME}:${port}`;
  const client = input.createClient({ url });
  const process = input.spawnServer({
    binaryPath: input.binaryPath,
    hostname: HOSTNAME,
    port,
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let processError: Error | null = null;
  let closed = false;
  let version = "unknown";

  process.stdout?.on("data", (chunk) => {
    stdoutBuffer = appendLogBuffer(stdoutBuffer, chunk);
  });
  process.stderr?.on("data", (chunk) => {
    stderrBuffer = appendLogBuffer(stderrBuffer, chunk);
  });
  process.once("error", (error) => {
    processError = error;
  });
  process.once("exit", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
  });

  const describeFailure = () => {
    if (processError) {
      return `Failed to start OpenCode server: ${processError.message}`;
    }

    if (exitCode === null && exitSignal === null) {
      return null;
    }

    const output = `${stdoutBuffer}\n${stderrBuffer}`.trim();
    return output.length > 0
      ? `OpenCode server exited before becoming healthy (code=${exitCode ?? "null"}, signal=${exitSignal ?? "null"}). ${output}`
      : `OpenCode server exited before becoming healthy (code=${exitCode ?? "null"}, signal=${exitSignal ?? "null"}).`;
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (exitCode !== null || exitSignal !== null || processError) {
      return;
    }
    killServerProcess(process);
  };

  const requestHealth = async (): Promise<GlobalHealthResponse> => {
    const health = await readSdkData<GlobalHealthResponse>(
      client.global.health({ signal: AbortSignal.timeout(input.healthCheckTimeoutMs) }),
      "global.health",
    );
    version = health.version;
    return health;
  };

  const state: ManagedServerState = {
    binaryPath: input.binaryPath,
    url,
    client,
    get version() {
      return version;
    },
    close,
    isExited: () => processError !== null || exitCode !== null || exitSignal !== null,
    describeFailure,
    refreshHealth: requestHealth,
    probeMetadata: async () => {
      const [configuredProviders, knownProviders, authMethodsByProviderId] = await Promise.all([
        readSdkData<ConfigProvidersResponse>(client.config.providers(), "config.providers"),
        readSdkData<ProviderListResponse>(client.provider.list(), "provider.list"),
        readSdkData<ProviderAuthResponse>(client.provider.auth(), "provider.auth"),
      ]);

      return {
        configuredProviders: configuredProviders.providers,
        knownProviders: knownProviders.all,
        connectedProviderIds: knownProviders.connected,
        authMethodsByProviderId,
        defaultModelByProviderId: configuredProviders.default,
      };
    },
  };

  try {
    await waitForHealthy({
      state,
      startTimeoutMs: input.startTimeoutMs,
      healthCheckIntervalMs: input.healthCheckIntervalMs,
    });
    return state;
  } catch (error) {
    close();
    throw error;
  }
}

export const makeOpencodeServerManager = (dependencies: OpencodeServerManagerDependencies = {}) =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<ManagedServerState | null>(null);
    const semaphore = yield* Semaphore.make(1);

    const spawnServer = dependencies.spawnServer ?? createLiveServerProcess;
    const createClient = dependencies.createClient ?? createLiveClient;
    const pickPort = dependencies.pickPort ?? pickAvailablePort;
    const startTimeoutMs = dependencies.startTimeoutMs ?? SERVER_START_TIMEOUT_MS;
    const healthCheckTimeoutMs = dependencies.healthCheckTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
    const healthCheckIntervalMs = dependencies.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;

    const stopCurrentServer = Effect.gen(function* () {
      const current = yield* Ref.get(stateRef);
      if (!current) {
        return;
      }
      current.close();
      yield* Ref.set(stateRef, null);
    });

    const ensureServerBase = Effect.fn("ensureServerBase")(function* (input: {
      readonly binaryPath: string;
    }) {
      const current = yield* Ref.get(stateRef);
      if (current) {
        if (current.binaryPath !== input.binaryPath || current.isExited()) {
          yield* stopCurrentServer;
        } else {
          const health = yield* Effect.tryPromise({
            try: () => current.refreshHealth(),
            catch: (error) => toManagerError("global.health", error),
          }).pipe(Effect.result);

          if (Result.isSuccess(health)) {
            return {
              binaryPath: current.binaryPath,
              url: current.url,
              client: current.client,
              version: health.success.version,
            } satisfies OpencodeServerHandle;
          }

          yield* stopCurrentServer;
        }
      }

      const next = yield* Effect.tryPromise({
        try: () =>
          startManagedServer({
            binaryPath: input.binaryPath,
            spawnServer,
            createClient,
            pickPort,
            startTimeoutMs,
            healthCheckTimeoutMs,
            healthCheckIntervalMs,
          }),
        catch: (error) => toManagerError("ensureServer", error),
      });

      yield* Ref.set(stateRef, next);
      return {
        binaryPath: next.binaryPath,
        url: next.url,
        client: next.client,
        version: next.version,
      } satisfies OpencodeServerHandle;
    });

    const ensureServer = (input: { readonly binaryPath: string }) =>
      semaphore.withPermits(1)(ensureServerBase(input));

    const probe = (input: { readonly binaryPath: string }) =>
      ensureServer(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const current = yield* Ref.get(stateRef);
            if (!current) {
              return yield* new OpencodeServerManagerError({
                operation: "probe",
                detail: "OpenCode server state disappeared before probing metadata.",
              });
            }

            const metadata = yield* Effect.tryPromise({
              try: () => current.probeMetadata(),
              catch: (error) => toManagerError("probe", error),
            });

            return {
              server: {
                binaryPath: current.binaryPath,
                url: current.url,
                client: current.client,
                version: current.version,
              },
              configuredProviders: metadata.configuredProviders,
              knownProviders: metadata.knownProviders,
              connectedProviderIds: metadata.connectedProviderIds,
              authMethodsByProviderId: metadata.authMethodsByProviderId,
              defaultModelByProviderId: metadata.defaultModelByProviderId,
            };
          }),
        ),
      );

    return {
      ensureServer,
      probe,
      stop: semaphore.withPermits(1)(stopCurrentServer),
    } satisfies OpencodeServerManagerShape;
  });

export const OpencodeServerManagerLive = Layer.effect(
  OpencodeServerManager,
  Effect.acquireRelease(makeOpencodeServerManager(), (manager) => manager.stop.pipe(Effect.orDie)),
);
