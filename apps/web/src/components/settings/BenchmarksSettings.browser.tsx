import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationThread,
  ProjectId,
  type OrchestrationReadModel,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { __resetLocalApiForTests } from "../../localApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { getServerConfig } from "../../rpc/serverState";
import { getRouter } from "../../router";
import { resetServerStateForTests } from "../../rpc/serverState";
import { getWsConnectionStatus } from "../../rpc/wsConnectionState";
import { selectBootstrapCompleteForActiveEnvironment, useStore } from "../../store";
import { createAuthenticatedSessionHandlers } from "../../../test/authHttpHandlers";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../../test/wsRpcHarness";

vi.mock("../../lib/gitStatusState", () => ({
  useGitStatus: () => ({
    data: { isRepo: true, branch: "main" },
    error: null,
    cause: null,
    isPending: false,
  }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const NOW_ISO = "2026-04-21T12:00:00.000Z";
const VIEWPORT = { width: 1400, height: 1000 };

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
}

type DispatchThreadTurnStartRequest = {
  _tag: typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
  type: "thread.turn.start";
  threadId: ThreadId;
  titleSeed?: string;
  modelSelection: OrchestrationThread["modelSelection"];
  message: {
    messageId: MessageId;
    text: string;
  };
};

const rpcHarness = new BrowserWsRpcHarness();
const wsRequests = rpcHarness.requests;
const wsLink = ws.link(/ws(s)?:\/\/.*/);
let fixture: TestFixture;
let customWsRpcResolver: ((body: NormalizedWsRpcRequestBody) => unknown | undefined) | null = null;

function createServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: LOCAL_ENVIRONMENT_ID,
      label: "Local environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        runtimeCapabilities: { busyFollowupMode: "queue-only" },
        models: [
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [{ value: "medium", label: "medium", isDefault: true }],
              supportsFastMode: true,
              supportsThinkingToggle: false,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
        ],
      },
      {
        provider: "claudeAgent",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        runtimeCapabilities: { busyFollowupMode: "queue-only" },
        models: [
          {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [{ value: "medium", label: "medium", isDefault: true }],
              supportsFastMode: false,
              supportsThinkingToggle: true,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
        ],
      },
      {
        provider: "opencode",
        enabled: true,
        installed: true,
        version: "0.1.0",
        status: "ready",
        auth: { status: "unknown" },
        checkedAt: NOW_ISO,
        runtimeCapabilities: { busyFollowupMode: "queue-only" },
        models: [
          {
            slug: "openai/gpt-5",
            name: "OpenAI GPT-5",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [{ value: "medium", label: "medium", isDefault: true }],
              supportsFastMode: false,
              supportsThinkingToggle: false,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
        ],
      },
    ],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          hiddenModels: [],
        },
      },
    },
  };
}

function createSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [],
    updatedAt: NOW_ISO,
  };
}

function createWelcome(): ServerLifecycleWelcomePayload {
  return {
    environment: {
      environmentId: LOCAL_ENVIRONMENT_ID,
      label: "Local environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    cwd: "/repo/project",
    projectName: "Project",
    bootstrapProjectId: PROJECT_ID,
  };
}

function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
  const custom = customWsRpcResolver?.(body);
  if (custom !== undefined) {
    return custom;
  }
  if (body._tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (body._tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (body._tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      nextCursor: null,
      totalCount: 1,
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    void rpcHarness.connect(client);
    client.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      void rpcHarness.onMessage(event.data);
    });
  }),
  ...createAuthenticatedSessionHandlers(() => fixture.serverConfig.auth),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
  http.get("*/.well-known/t3/environment", () =>
    HttpResponse.json(fixture.serverConfig.environment, { status: 200 }),
  ),
);

async function nextFrame() {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function waitForLayout() {
  await nextFrame();
  await nextFrame();
}

async function waitForInitialWsSubscriptions() {
  await vi.waitFor(
    () => {
      expect(
        rpcHarness.requests.some((request) => request._tag === WS_METHODS.subscribeServerLifecycle),
      ).toBe(true);
      expect(
        rpcHarness.requests.some((request) => request._tag === WS_METHODS.subscribeServerConfig),
      ).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForWsConnection() {
  await vi.waitFor(
    () => {
      expect(getWsConnectionStatus().phase).toBe("connected");
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForServerConfigSnapshot() {
  await vi.waitFor(
    () => {
      expect(getServerConfig()).not.toBeNull();
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForAppBootstrap() {
  await vi.waitFor(
    () => {
      expect(selectBootstrapCompleteForActiveEnvironment(useStore.getState())).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function selectBaseBranch(branchName: string) {
  await page.getByTestId("benchmark-base-branch-trigger").click();
  await page.getByRole("option", { name: branchName }).click();
}

async function mountBenchmarksRoute(options?: {
  resolveRpc?: (body: NormalizedWsRpcRequestBody) => unknown | undefined;
  configureFixture?: (fixture: TestFixture) => TestFixture;
}) {
  customWsRpcResolver = options?.resolveRpc ?? null;
  await page.viewport(VIEWPORT.width, VIEWPORT.height);
  const nextFixture = {
    snapshot: createSnapshot(),
    serverConfig: createServerConfig(),
    welcome: createWelcome(),
  };
  fixture = options?.configureFixture ? options.configureFixture(nextFixture) : nextFixture;
  writePrimaryEnvironmentDescriptor(fixture.serverConfig.environment);
  useStore.setState({
    activeEnvironmentId: LOCAL_ENVIRONMENT_ID,
    environmentStateById: {},
  });

  const host = document.createElement("div");
  host.style.width = "100vw";
  host.style.height = "100vh";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: ["/settings/benchmarks"],
    }),
  );

  const screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    { container: host },
  );

  await waitForInitialWsSubscriptions();
  await waitForWsConnection();
  await waitForServerConfigSnapshot();
  await waitForAppBootstrap();
  await waitForLayout();

  return {
    router,
    cleanup: async () => {
      customWsRpcResolver = null;
      await screen.unmount();
      host.remove();
    },
  };
}

describe("BenchmarksSettings", () => {
  beforeAll(async () => {
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    await rpcHarness.reset({
      resolveUnary: resolveWsRpc,
      getInitialStreamValues: (request) => {
        if (request._tag === WS_METHODS.subscribeServerConfig) {
          return [
            {
              version: 1,
              type: "snapshot",
              config: fixture.serverConfig,
            },
          ];
        }
        if (request._tag === WS_METHODS.subscribeServerLifecycle) {
          return [
            {
              version: 1,
              sequence: 1,
              type: "welcome",
              payload: fixture.welcome,
            },
          ];
        }
        return [];
      },
    });
    await __resetLocalApiForTests();
    resetServerStateForTests();
    wsRequests.length = 0;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  afterEach(() => {
    customWsRpcResolver = null;
    document.body.innerHTML = "";
  });

  it("renders Benchmarks below Connections in settings nav", async () => {
    const mounted = await mountBenchmarksRoute();

    try {
      const navButtons = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="sidebar-menu-button"]'),
      )
        .map((button) => button.textContent?.trim())
        .filter((text): text is string => Boolean(text));
      const connectionsIndex = navButtons.indexOf("Connections");
      const benchmarksIndex = navButtons.indexOf("Benchmarks");
      expect(connectionsIndex).toBeGreaterThanOrEqual(0);
      expect(benchmarksIndex).toBe(connectionsIndex + 1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders /settings/benchmarks", async () => {
    const mounted = await mountBenchmarksRoute();

    try {
      await expect.element(page.getByRole("heading", { name: "Benchmarks" })).toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe("/settings/benchmarks");
    } finally {
      await mounted.cleanup();
    }
  });

  it("collapses and expands the benchmark setup pane", async () => {
    const mounted = await mountBenchmarksRoute();

    try {
      expect(document.getElementById("benchmark-setup-pane")?.hidden).toBe(false);

      await page.getByRole("button", { name: "Collapse setup pane" }).click();

      await vi.waitFor(() => {
        expect(document.getElementById("benchmark-setup-pane")?.hidden).toBe(true);
        expect(
          document
            .querySelector('[aria-controls="benchmark-setup-pane"]')
            ?.getAttribute("aria-expanded"),
        ).toBe("false");
      });

      await page.getByRole("button", { name: "Expand setup pane" }).click();

      await vi.waitFor(() => {
        expect(document.getElementById("benchmark-setup-pane")?.hidden).toBe(false);
        expect(
          document
            .querySelector('[aria-controls="benchmark-setup-pane"]')
            ?.getAttribute("aria-expanded"),
        ).toBe("true");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables Run for missing prompt, missing branch, or fewer than 2 lanes", async () => {
    const mounted = await mountBenchmarksRoute();

    try {
      const runButton = page.getByRole("button", { name: "Run" });
      await expect.element(runButton).toBeDisabled();

      await selectBaseBranch("main");
      await expect.element(runButton).toBeDisabled();

      await page.getByLabelText("Prompt").fill("Benchmark prompt");
      await expect.element(runButton).not.toBeDisabled();

      await page.getByRole("button", { name: "Remove lane 2" }).click();
      await expect.element(page.getByText("At least 2 lanes are required.")).toBeInTheDocument();
      await expect.element(runButton).toBeDisabled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("respects hidden model settings in lane picker", async () => {
    const mounted = await mountBenchmarksRoute({
      configureFixture: (currentFixture) => {
        const serverConfig = {
          ...currentFixture.serverConfig,
          settings: {
            ...currentFixture.serverConfig.settings,
            providers: {
              ...currentFixture.serverConfig.settings.providers,
              claudeAgent: {
                ...currentFixture.serverConfig.settings.providers.claudeAgent,
                hiddenModels: ["claude-sonnet-4-6"],
              },
            },
          },
        } satisfies ServerConfig;

        return {
          ...currentFixture,
          serverConfig,
        };
      },
    });

    try {
      await page
        .getByRole("button", { name: /claude/i })
        .nth(0)
        .click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Claude Sonnet 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("dispatches one command per lane on Run", async () => {
    const mounted = await mountBenchmarksRoute();

    try {
      await selectBaseBranch("main");
      await page.getByLabelText("Prompt").fill("Benchmark prompt");
      await page.getByRole("button", { name: "Run" }).click();

      await vi.waitFor(() => {
        const turnStarts = wsRequests.filter(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            request.type === "thread.turn.start",
        );
        expect(turnStarts).toHaveLength(2);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows failed dispatch without removing successful lane shells", async () => {
    let dispatchCount = 0;
    const mounted = await mountBenchmarksRoute({
      resolveRpc: (body) => {
        if (
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          body.type === "thread.turn.start"
        ) {
          dispatchCount += 1;
          if (dispatchCount === 2) {
            throw new Error("Lane failed");
          }
          return {};
        }
        return undefined;
      },
    });

    try {
      await selectBaseBranch("main");
      await page.getByLabelText("Prompt").fill("Benchmark prompt");
      await page.getByRole("button", { name: "Run" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Lane failed");
        expect(
          Array.from(document.querySelectorAll("a")).some((link) =>
            link.textContent?.includes("Open full chat"),
          ),
        ).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("embedded benchmark chat mode omits duplicate global route controls", async () => {
    const mounted = await mountBenchmarksRoute({
      resolveRpc: (body) => {
        if (
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          body.type === "thread.turn.start"
        ) {
          const command = body as DispatchThreadTurnStartRequest;
          const thread = {
            id: ThreadId.make(String(command.threadId)),
            projectId: PROJECT_ID,
            title:
              typeof command.titleSeed === "string" && command.titleSeed.length > 0
                ? command.titleSeed
                : "Benchmark lane",
            modelSelection: command.modelSelection,
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: "main",
            worktreePath: "/tmp/worktree",
            latestTurn: null,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
            archivedAt: null,
            deletedAt: null,
            messages: [
              {
                id: MessageId.make(String(command.message.messageId)),
                role: "user",
                text: command.message.text,
                turnId: null,
                streaming: false,
                createdAt: NOW_ISO,
                updatedAt: NOW_ISO,
                attachments: [],
              },
            ],
            activities: [],
            proposedPlans: [],
            queuedFollowups: [],
            checkpoints: [],
            session: {
              threadId: ThreadId.make(String(command.threadId)),
              status: "ready",
              providerName: command.modelSelection.provider,
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW_ISO,
            },
          } satisfies OrchestrationThread;
          fixture.snapshot = {
            ...fixture.snapshot,
            snapshotSequence: fixture.snapshot.snapshotSequence + 1,
            threads: [...fixture.snapshot.threads, thread],
          };
          useStore.getState().syncServerReadModel(fixture.snapshot, LOCAL_ENVIRONMENT_ID);
          return {};
        }
        return undefined;
      },
    });

    try {
      await selectBaseBranch("main");
      await page.getByLabelText("Prompt").fill("Benchmark prompt");
      await page.getByRole("button", { name: "Run" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Open full chat");
      });

      expect(document.querySelector('[aria-label="Toggle terminal drawer"]')).toBeNull();
      expect(document.querySelector('[aria-label="Toggle right panel"]')).toBeNull();
      expect(document.body.textContent ?? "").toContain("Open full chat");
    } finally {
      await mounted.cleanup();
    }
  });
});
