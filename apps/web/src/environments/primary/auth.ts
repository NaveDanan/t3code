import type {
  AuthBearerBootstrapResult,
  AuthBootstrapInput,
  AuthClientMetadata,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionId,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "@t3tools/contracts";

import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "../../pairingUrl";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from "./target";
import { Data, Predicate } from "effect";

export class BootstrapHttpError extends Data.TaggedError("BootstrapHttpError")<{
  readonly message: string;
  readonly status: number;
}> {}

export class BootstrapTimeoutError extends Data.TaggedError("BootstrapTimeoutError")<{
  readonly message: string;
}> {}

const isBootstrapHttpError = (u: unknown): u is BootstrapHttpError =>
  Predicate.isTagged(u, "BootstrapHttpError");

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie" | "bearer-session-token";
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

type ServerAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;
const BOOTSTRAP_FETCH_TIMEOUT_MS = 10_000;
const PRIMARY_DESKTOP_BEARER_SESSION_STORAGE_KEY = "t3.primary.desktopBearerSession";

let primaryDesktopBearerSessionToken: string | null = null;

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);
  if (next.toString() === url.toString()) {
    return;
  }
  window.history.replaceState({}, document.title, next.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (!token) {
    return null;
  }
  stripPairingTokenFromUrl();
  return token;
}

function getDesktopBootstrapCredential(): string | null {
  const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap();
  return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
    ? bootstrap.bootstrapToken
    : null;
}

function normalizeBearerSessionToken(token: string | null | undefined): string | null {
  const trimmedToken = token?.trim();
  return trimmedToken && trimmedToken.length > 0 ? trimmedToken : null;
}

function isDesktopManagedPrimaryEnvironment(): boolean {
  return readPrimaryEnvironmentTarget()?.source === "desktop-managed";
}

function readPrimaryDesktopBearerSessionTokenFromStorage(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return normalizeBearerSessionToken(
      window.sessionStorage?.getItem(PRIMARY_DESKTOP_BEARER_SESSION_STORAGE_KEY) ?? null,
    );
  } catch {
    return null;
  }
}

function writePrimaryDesktopBearerSessionToken(token: string | null): void {
  const normalizedToken = normalizeBearerSessionToken(token);
  primaryDesktopBearerSessionToken = normalizedToken;

  if (typeof window === "undefined") {
    return;
  }

  try {
    if (!window.sessionStorage) {
      return;
    }

    if (normalizedToken) {
      window.sessionStorage.setItem(PRIMARY_DESKTOP_BEARER_SESSION_STORAGE_KEY, normalizedToken);
      return;
    }

    window.sessionStorage.removeItem(PRIMARY_DESKTOP_BEARER_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage access failures and fall back to the in-memory copy.
  }
}

export function readPrimaryBearerSessionToken(): string | null {
  if (!isDesktopManagedPrimaryEnvironment()) {
    return null;
  }

  const inMemoryToken = normalizeBearerSessionToken(primaryDesktopBearerSessionToken);
  if (inMemoryToken) {
    return inMemoryToken;
  }

  const storedToken = readPrimaryDesktopBearerSessionTokenFromStorage();
  primaryDesktopBearerSessionToken = storedToken;
  return storedToken;
}

function buildPrimaryAuthRequestInit(init?: RequestInit): RequestInit {
  const bearerToken = readPrimaryBearerSessionToken();
  const headers = new Headers(init?.headers);
  if (bearerToken) {
    headers.set("authorization", `Bearer ${bearerToken}`);
  }

  const nextInit: RequestInit = {
    ...init,
    ...(bearerToken ? {} : { credentials: init?.credentials ?? "include" }),
  };

  let hasHeaders = false;
  headers.forEach(() => {
    hasHeaders = true;
  });
  if (hasHeaders) {
    nextInit.headers = headers;
  }

  return nextInit;
}

export function logBootstrapDebug(
  message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  if (import.meta.env.MODE === "test") {
    return;
  }
  const logger = console[level] ?? console.info;
  logger(`[bootstrap] ${message}`);
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchWithBootstrapTimeout(
  input: string,
  init: RequestInit,
  timeoutMessage: string,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BOOTSTRAP_FETCH_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      throw new BootstrapTimeoutError({
        message: `${timeoutMessage} (${BOOTSTRAP_FETCH_TIMEOUT_MS}ms).`,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSessionState(options?: {
  readonly quiet?: boolean;
}): Promise<AuthSessionState> {
  return retryTransientBootstrap(async () => {
    const sessionUrl = resolvePrimaryEnvironmentHttpUrl("/api/auth/session");
    if (!options?.quiet) {
      logBootstrapDebug(`loading auth session url=${sessionUrl}`);
    }
    const response = await fetchWithBootstrapTimeout(
      sessionUrl,
      buildPrimaryAuthRequestInit(),
      "Timed out loading server auth session state",
    );
    if (!response.ok) {
      throw new BootstrapHttpError({
        message: `Failed to load server auth session state (${response.status}).`,
        status: response.status,
      });
    }
    const session = (await response.json()) as AuthSessionState;
    if (!session.authenticated && readPrimaryBearerSessionToken()) {
      writePrimaryDesktopBearerSessionToken(null);
    }
    if (!options?.quiet) {
      logBootstrapDebug(
        `auth session loaded authenticated=${session.authenticated} policy=${session.auth.policy}`,
      );
    }
    return session;
  });
}

async function readErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const text = await response.text();
  return text || fallbackMessage;
}

async function exchangeBootstrapCredential(credential: string): Promise<void> {
  return retryTransientBootstrap(async () => {
    const payload: AuthBootstrapInput = { credential };
    const useBearerBootstrap = isDesktopManagedPrimaryEnvironment();
    const bootstrapUrl = resolvePrimaryEnvironmentHttpUrl(
      useBearerBootstrap ? "/api/auth/bootstrap/bearer" : "/api/auth/bootstrap",
    );
    logBootstrapDebug(`posting desktop bootstrap credential url=${bootstrapUrl}`);
    const response = await fetchWithBootstrapTimeout(
      bootstrapUrl,
      buildPrimaryAuthRequestInit({
        body: JSON.stringify(payload),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      }),
      "Timed out bootstrapping desktop auth session",
    );

    if (!response.ok) {
      const message = await response.text();
      throw new BootstrapHttpError({
        message: message || `Failed to bootstrap auth session (${response.status}).`,
        status: response.status,
      });
    }

    if (useBearerBootstrap) {
      const result = (await response.json()) as AuthBearerBootstrapResult;
      writePrimaryDesktopBearerSessionToken(result.sessionToken);
    } else {
      await response.json();
    }

    logBootstrapDebug(`desktop bootstrap exchange succeeded status=${response.status}`);
  });
}

async function issuePrimaryWebSocketToken(): Promise<AuthWebSocketTokenResult> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/ws-token"),
    buildPrimaryAuthRequestInit({
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to issue websocket token (${response.status}).`),
    );
  }

  return (await response.json()) as AuthWebSocketTokenResult;
}

export async function resolvePrimaryWebSocketConnectionUrl(): Promise<string> {
  const primaryTarget = readPrimaryEnvironmentTarget();
  if (!primaryTarget) {
    throw new Error("Unable to resolve the primary environment websocket URL.");
  }

  const bearerToken = readPrimaryBearerSessionToken();
  if (!bearerToken) {
    return primaryTarget.target.wsBaseUrl;
  }

  const issued = await issuePrimaryWebSocketToken();
  const url = new URL(primaryTarget.target.wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}

async function waitForAuthenticatedSessionAfterBootstrap(): Promise<AuthSessionState> {
  const startedAt = Date.now();
  logBootstrapDebug("waiting for authenticated session after bootstrap");

  while (true) {
    const session = await fetchSessionState({ quiet: true });
    if (session.authenticated) {
      logBootstrapDebug("authenticated session observed after bootstrap");
      return session;
    }

    if (Date.now() - startedAt >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) {
      logBootstrapDebug("timed out waiting for authenticated session after bootstrap", "warn");
      throw new Error("Timed out waiting for authenticated session after bootstrap.");
    }

    await waitForBootstrapRetry(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

export async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBootstrapError(error)) {
        throw error;
      }

      if (Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
        throw error;
      }

      await waitForBootstrapRetry(BOOTSTRAP_RETRY_STEP_MS);
    }
  }
}

function waitForBootstrapRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientBootstrapError(error: unknown): boolean {
  if (isBootstrapHttpError(error)) {
    return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof DOMException && error.name === "AbortError";
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const bootstrapCredential = getDesktopBootstrapCredential();
  logBootstrapDebug(
    `starting auth gate resolution desktopCredential=${bootstrapCredential ? "present" : "missing"}`,
  );
  const currentSession = await fetchSessionState();
  if (currentSession.authenticated) {
    logBootstrapDebug("auth gate already satisfied by existing session");
    return { status: "authenticated" };
  }

  if (!bootstrapCredential) {
    logBootstrapDebug("no desktop bootstrap credential available; pairing required", "warn");
    return {
      status: "requires-auth",
      auth: currentSession.auth,
    };
  }

  try {
    await exchangeBootstrapCredential(bootstrapCredential);
    await waitForAuthenticatedSessionAfterBootstrap();
    logBootstrapDebug("silent desktop bootstrap completed");
    return { status: "authenticated" };
  } catch (error) {
    logBootstrapDebug(
      `silent desktop bootstrap failed message=${error instanceof Error ? error.message : "Authentication failed."}`,
      "warn",
    );
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();
  if (!trimmedCredential) {
    throw new Error("Enter a pairing token to continue.");
  }

  await exchangeBootstrapCredential(trimmedCredential);
  bootstrapPromise = null;
  stripPairingTokenFromUrl();
}

export async function createServerPairingCredential(
  label?: string,
): Promise<AuthPairingCredentialResult> {
  const trimmedLabel = label?.trim();
  const payload: AuthCreatePairingCredentialInput = trimmedLabel ? { label: trimmedLabel } : {};
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-token"),
    buildPrimaryAuthRequestInit({
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to create pairing credential (${response.status}).`),
    );
  }

  return (await response.json()) as AuthPairingCredentialResult;
}

export async function listServerPairingLinks(): Promise<ReadonlyArray<ServerPairingLinkRecord>> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-links"),
    buildPrimaryAuthRequestInit(),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load pairing links (${response.status}).`),
    );
  }

  return (await response.json()) as ReadonlyArray<ServerPairingLinkRecord>;
}

export async function revokeServerPairingLink(id: string): Promise<void> {
  const payload: AuthRevokePairingLinkInput = { id };
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-links/revoke"),
    buildPrimaryAuthRequestInit({
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to revoke pairing link (${response.status}).`),
    );
  }
}

export async function listServerClientSessions(): Promise<
  ReadonlyArray<ServerClientSessionRecord>
> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/clients"),
    buildPrimaryAuthRequestInit(),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load paired clients (${response.status}).`),
    );
  }

  return (await response.json()) as ReadonlyArray<ServerClientSessionRecord>;
}

export async function revokeServerClientSession(sessionId: AuthSessionId): Promise<void> {
  const payload: AuthRevokeClientSessionInput = { sessionId };
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/clients/revoke"),
    buildPrimaryAuthRequestInit({
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to revoke client session (${response.status}).`),
    );
  }
}

export async function revokeOtherServerClientSessions(): Promise<number> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/clients/revoke-others"),
    buildPrimaryAuthRequestInit({
      method: "POST",
    }),
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to revoke other client sessions (${response.status}).`,
      ),
    );
  }

  const result = (await response.json()) as { revokedCount?: number };
  return result.revokedCount ?? 0;
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  const nextPromise = bootstrapServerAuth();
  bootstrapPromise = nextPromise;
  return nextPromise.finally(() => {
    if (bootstrapPromise === nextPromise) {
      bootstrapPromise = null;
    }
  });
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  primaryDesktopBearerSessionToken = null;
  writePrimaryDesktopBearerSessionToken(null);
}
