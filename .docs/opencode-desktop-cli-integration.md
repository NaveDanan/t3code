# OpenCode Desktop and CLI Integration

## Purpose

This document explains how OpenCode Desktop integrates with the OpenCode CLI in the upstream `anomalyco/opencode` repository, with emphasis on the concrete runtime boundary that matters for implementing an OpenCode harness in T3 Code.

The key conclusion is simple:

- OpenCode Desktop does not automate the interactive CLI or TUI over stdin or stdout.
- It packages or launches an `opencode-cli` binary as a managed child process.
- That child process is started in headless server mode with `serve`.
- The desktop frontend then talks to that local server over HTTP and SSE using the generated `@opencode-ai/sdk` client.

That means the architectural boundary is not "desktop <-> CLI text protocol". It is "desktop shell <-> managed `opencode serve` sidecar <-> HTTP or SSE control plane".

This is the correct mental model to carry into T3 Code.

## Short Version

If you only need the most important facts, these are the ones that matter:

1. The desktop app is a native wrapper around a local OpenCode server sidecar.
2. The sidecar is launched with `opencode-cli serve --hostname 127.0.0.1 --port <port>` plus Basic Auth credentials.
3. The frontend gets the sidecar URL and credentials from native code before the server is fully healthy.
4. The shared app then constructs an SDK client with `baseUrl` plus `Authorization: Basic ...`.
5. Realtime updates come from SSE, not from parsing terminal output.
6. SQLite migration progress is the main thing the desktop shell still infers from sidecar logs.
7. The server API is the canonical contract. The JS SDK is generated from the server's OpenAPI description.
8. The same server-first contract is also used by the TUI, `run --attach`, ACP, and other programmatic integrations.
9. For T3 Code, the right harness shape is a process manager plus HTTP or SSE client layer, not an interactive CLI transcript parser.

## Package Map

The relevant packages in upstream `anomalyco/opencode` are:

| Package                     | Role                                                                      | Why it matters                                                                       |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/opencode`         | Core CLI, server, session engine, provider integration, routes, event bus | This is the actual runtime product. `serve` lives here.                              |
| `packages/sdk/js`           | Generated JS or TS client and convenience server launcher                 | Proves the server API is the real external contract.                                 |
| `packages/app`              | Shared frontend app used by web and desktop shells                        | Most desktop behavior above raw process management lives here.                       |
| `packages/desktop`          | Tauri desktop shell                                                       | Native sidecar spawning, health checks, IPC commands, loading window, WSL utilities. |
| `packages/desktop-electron` | Electron desktop shell                                                    | Same architectural pattern as Tauri, implemented with Electron IPC.                  |
| `packages/web`              | Docs and web-facing materials                                             | Useful for understanding the published API shape and architecture language.          |

The crucial split is this:

- `packages/opencode` owns the OpenCode runtime.
- `packages/desktop` and `packages/desktop-electron` own native process supervision and platform integration.
- `packages/app` owns UI state, SDK usage, server selection, sync, and event handling.

## Core Architecture

At runtime, the system looks like this:

```text
Native Desktop Shell (Tauri or Electron)
  |
  | spawn packaged opencode-cli sidecar
  | set env vars, auth, state dir, platform glue
  v
opencode-cli serve
  |
  | exposes local HTTP + SSE control plane
  v
OpenCode Server (Hono + Bun + session engine + provider layer)
  |
  | /global/health
  | /global/event
  | /event
  | /session/*
  | /provider/*
  | /config/*
  | /file, /path, /vcs, /mcp, /agent, ...
  v
Shared Frontend App (@opencode-ai/app)
  |
  | createOpencodeClient(baseUrl, headers)
  | subscribe to SSE
  | render session UX
  v
Desktop UI
```

The important non-obvious part is that the desktop frontend is not special to the core runtime. It is just another client of the OpenCode server.

That is also how the TUI is described upstream: when you run plain `opencode`, the TUI and server both start, and the TUI is the client talking to the server. `opencode serve` simply starts the server without the TUI.

## High-Level Lifecycle

### 1. Desktop app starts

Both native shells do the same conceptual work on startup:

1. Set up native app plumbing.
2. Optionally sync the globally installed CLI to the app version.
3. Choose a loopback port.
4. Generate a random per-launch password.
5. Spawn a local sidecar server.
6. Start waiting for health and migration completion.
7. Expose sidecar connection info to the renderer immediately.
8. Let the shared app connect over HTTP and SSE.

The Tauri implementation is in `packages/desktop/src-tauri/src/lib.rs` and the Electron implementation is in `packages/desktop-electron/src/main/index.ts`.

### 2. Native code chooses local server address

The sidecar is always started on loopback, typically `127.0.0.1` and a dynamic port:

- Tauri: `get_sidecar_port()` uses `OPENCODE_PORT` if present, otherwise binds to `127.0.0.1:0` to find a free port.
- Electron: `getSidecarPort()` does the same thing using Node's `net.createServer()`.

This matters because the desktop shell is deliberately creating an isolated local server instance, not assuming a preexisting global daemon.

### 3. Native code generates per-launch credentials

The desktop shell generates a random password per launch and pairs it with the default username `opencode`.

The result is surfaced as:

- `url`
- `username`
- `password`

This data is returned to the frontend through:

- Tauri command: `await_initialization`
- Electron IPC: `await-initialization`

Important detail:

- Credentials are exposed before the server health check completes.
- The renderer can know where the sidecar will be before the sidecar is fully ready.

That is intentional. The shared app handles connection gating and health state itself.

## Sidecar Process Model

### Packaged sidecar, not PATH resolution

The desktop apps do not rely on `opencode` being installed on the user's PATH for their own core runtime.

They resolve a packaged `opencode-cli` binary from the app bundle:

- Tauri resolves a sibling `opencode-cli` binary near the app binary.
- Electron resolves `opencode-cli` from app resources in packaged mode, or from local `resources` in dev mode.

This is a major harness design insight:

- The desktop shell treats the OpenCode runtime as an app-managed artifact.
- The optional globally installed CLI is a separate convenience feature.

For T3 Code, the equivalent is likely a managed binary path setting or a bundled binary strategy, not blind trust in PATH.

### Installed CLI vs bundled sidecar are separate concerns

Upstream desktop code clearly separates these two ideas:

1. Bundled sidecar:
   - Used by the desktop app itself.
   - Must exist for the app to function.
   - Version-pinned to the desktop app.

2. Installed CLI:
   - Optional user convenience for terminal usage.
   - Installed into `~/.opencode/bin/opencode`.
   - Can be upgraded or synced from the desktop app.

Both Tauri and Electron implement:

- `install_cli`
- `sync_cli`

`sync_cli` compares the installed CLI version against the desktop app version and upgrades only if the installed CLI is older.

This is not required for the desktop sidecar to run. It is an extra user-facing feature.

### Actual spawn command

The sidecar is started with the equivalent of:

```bash
opencode-cli --print-logs --log-level WARN serve --hostname 127.0.0.1 --port <port>
```

The desktop shell also injects:

```text
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<random password>
```

This is the exact pattern T3 should copy for a local OpenCode manager.

### Desktop-specific environment variables

The desktop process injects additional environment variables before spawning the sidecar:

- `OPENCODE_EXPERIMENTAL_ICON_DISCOVERY=true`
- `OPENCODE_EXPERIMENTAL_FILEWATCHER=true`
- `OPENCODE_CLIENT=desktop`
- `XDG_STATE_HOME=<desktop app state dir>`

The exact state dir differs by shell:

- Tauri uses the app local data path.
- Electron uses `app.getPath("userData")`.

This means the desktop-controlled server intentionally runs with desktop-specific identity and state placement.

### Platform-specific launch behavior

The process launch details are important because they show where desktop-specific complexity lives.

#### Windows direct mode

If WSL mode is not enabled:

- Tauri launches the packaged sidecar binary directly.
- Electron launches the packaged sidecar binary directly.

#### Windows WSL mode

If WSL mode is enabled:

- The desktop shell does not use the packaged Windows binary for server execution.
- It runs `wsl -e bash -lc ...`.
- It expects a Linux CLI at `$HOME/.opencode/bin/opencode` inside WSL.
- If the CLI is missing there, it installs it by running the upstream install script inside WSL.

This is a concrete sign that upstream considers WSL a first-class execution target, not a workaround.

#### Unix shell mode

On Unix-like systems, the desktop shells do extra work so the sidecar inherits the user's login-shell environment.

Why this exists:

- Tool discovery often depends on shell startup files.
- PATH and other environment-sensitive integrations would be wrong if the sidecar only inherited the app process environment.

Tauri is more defensive here:

- It probes the user shell with `env -0`.
- It tries interactive login shell first.
- It falls back to login shell.
- It skips Nushell probing.
- It merges shell-loaded environment variables with explicit desktop overrides.

Electron follows the same overall idea through its `shell-env` helper, but the Tauri implementation exposes the mechanics more explicitly in source.

This is exactly the kind of operational detail that can make or break an agent runtime.

### Process supervision and shutdown

#### Tauri

Tauri uses Rust-side process wrapping and explicit lifecycle management:

- `process_wrap` process groups on Unix.
- Windows `JobObject`, `KillOnDrop`, and custom creation flags.
- Hidden window behavior on Windows.
- Line-by-line stdout and stderr capture.
- Kill signaling through a channel-backed `CommandChild`.

This is a serious process manager, not a naive fire-and-forget spawn.

#### Electron

Electron uses Node child processes plus `tree-kill`:

- Detached process group on non-Windows.
- `windowsHide: true`.
- Line-by-line stdout and stderr capture.
- Explicit `kill()` wrapper around `tree-kill(pid)`.

Tauri is stronger operationally, but both shells validate the same architecture.

## Health, Readiness, and Migration Gating

### Readiness is based on `/global/health`

The native desktop layer treats the sidecar as ready only after `/global/health` succeeds.

Upstream server health response is extremely simple:

```json
{ "healthy": true, "version": "..." }
```

The desktop shell polls this endpoint until success or process death.

This is the correct readiness concept for T3 as well.

Do not use:

- `opencode --version`
- child process still alive
- port merely bound

Use:

- successful health request against the actual server you intend to use

### Tauri disables proxies for loopback health checks

One especially good detail in `packages/desktop/src-tauri/src/server.rs` is that health checks disable proxies for loopback destinations.

Reason:

- Some environments set `HTTP_PROXY` or `HTTPS_PROXY` without excluding localhost.
- A desktop app talking to its own local sidecar should not accidentally go through that proxy configuration.

This is a real integration hardening detail worth copying if T3 has to support enterprise environments.

### SQLite migration progress is inferred from sidecar logs

This is the main place where desktop still watches raw process output for application semantics.

The sidecar emits lines like:

- `sqlite-migration:<percent>`
- `sqlite-migration:done`

The native shell converts those into native events:

- Tauri emits `SqliteMigrationProgress`
- Electron emits IPC events of the same shape

This is used to drive a loading overlay only when migrations take long enough to matter.

Important takeaway:

- Logs are used for startup UX hints.
- Logs are not the primary transport for prompts, sessions, or runtime state.

### Main window can appear before sidecar is healthy

Upstream desktop startup is intentionally split:

- The main window is created early.
- The health wait continues in parallel.
- The shared frontend performs its own connection gating.
- A separate loading window is only shown for long migrations.

This is another signal that the true client contract lives in the shared app and server provider layers, not in native startup sequencing.

## Native-to-Frontend Bridge

### Tauri bridge

Tauri exposes a generated command and event surface via Specta:

- `killSidecar`
- `installCli`
- `awaitInitialization`
- `getDefaultServerUrl`
- `setDefaultServerUrl`
- `getWslConfig`
- `setWslConfig`
- `getDisplayBackend`
- `setDisplayBackend`
- native helpers like `openPath`, `wslPath`, `checkAppExists`

Events include:

- `loadingWindowComplete`
- `sqliteMigrationProgress`

### Electron bridge

Electron exposes the same conceptual bridge through preload plus IPC:

- preload defines a safe `window.api`
- main registers handlers in `src/main/ipc.ts`
- renderer never talks to Node internals directly

The important bridge contract is the same in both shells:

- give renderer the sidecar connection details
- expose shell-specific UX and filesystem helpers
- keep server lifecycle in the native side

### `awaitInitialization` is the central handoff point

This is the main boundary between native shell and shared app.

It provides:

- the sidecar URL
- the Basic Auth username
- the Basic Auth password
- incremental init phase events such as `server_waiting`, `sqlite_waiting`, `done`

This handoff is a good model for T3 if you ever split process supervision from the UI or orchestration layers.

## The Shared App Is the Real Client

### Desktop reuses `@opencode-ai/app`

This is one of the most important structural findings.

The desktop packages are not large custom UIs. They mostly host the shared app and inject platform capabilities.

Evidence:

- `packages/desktop/package.json` depends on `@opencode-ai/app`
- `packages/desktop-electron/package.json` depends on `@opencode-ai/app`
- `packages/desktop/vite.config.ts` uses `@opencode-ai/app/vite`
- desktop public assets come from `../app/public`

So the native shell is thin. The shared app contains the real server-client logic.

### The renderer turns sidecar credentials into a `ServerConnection.Sidecar`

Once `awaitInitialization` resolves, the renderer creates a server object shaped like:

- type: `sidecar`
- variant: `base`
- http:
  - `url`
  - `username`
  - `password`

Then it renders:

```text
<AppInterface defaultServer="sidecar" servers={[sidecarServer]} />
```

This means the shared app treats the local sidecar exactly as one selectable server connection among potentially many server options.

### Default server selection can override the local sidecar

The desktop shell also persists a `defaultServerUrl`.

If present, the app can prefer a remote HTTP server instead of the local sidecar.

That matters for harness design because it shows upstream intentionally supports both:

- app-managed local server
- externally managed server attachment

This mirrors the CLI's `--attach` mode.

## How the Frontend Builds SDK Clients

### `createSdkForServer` is the critical helper

The shared app helper `packages/app/src/utils/server.ts` constructs an SDK client from a selected server connection.

It does two things:

1. Uses the server URL as `baseUrl`.
2. If `username` and `password` exist, injects an HTTP Basic Auth header.

Conceptually:

```ts
createOpencodeClient({
  baseUrl: server.url,
  headers: {
    Authorization: `Basic ${btoa(`${username}:${password}`)}`,
  },
});
```

That is the full frontend-to-sidecar transport contract.

### The renderer is not using raw fetch calls for business logic

Instead of hand-writing `fetch('/session/...')` everywhere, the shared app consistently builds typed SDK clients.

This is important for T3 because it strongly suggests:

- keep the OpenCode boundary typed
- do not scatter ad hoc HTTP requests around the codebase
- centralize auth, base URL, and directory handling in one helper

## SSE and Event Flow

### There are two related SSE surfaces

Upstream exposes at least two event streams that matter here:

1. `/event`
   - General event stream.
   - Emits `server.connected`, `server.heartbeat`, and bus events.
   - Used by lower-level clients such as the TUI SDK context.

2. `/global/event`
   - Global event stream with directory-aware wrapping.
   - Emits payloads grouped by `directory`.
   - Used by the shared app's `GlobalSDKProvider`.

That distinction matters because desktop's shared UI is managing multiple directories and broader application state, not only a single active session.

### The shared app keeps one global event subscription alive

`packages/app/src/context/global-sdk.tsx` is one of the most useful files to study.

It:

1. Creates an SDK client for the current selected server.
2. Starts a single global SSE stream.
3. Buffers queued events.
4. Coalesces noisy updates such as:
   - `session.status`
   - `lsp.updated`
   - `message.part.updated`
5. Marks some deltas stale when a newer full part update arrives.
6. Flushes events on a short frame-based cadence.
7. Uses heartbeat timeouts to detect a dead stream.
8. Automatically reconnects after short delays.

This is not just a convenience wrapper. It is a real event normalization layer.

### Server heartbeat and client heartbeat rules

The server emits heartbeat events roughly every 10 seconds on its SSE streams.

The shared app keeps a 15-second heartbeat timeout and aborts the current SSE attempt if no event arrives in time.

Then it reconnects after a small backoff.

This is good production behavior and worth copying.

### Event transport is already optimized for streaming

The server explicitly avoids compression for:

- `/event`
- `/global/event`
- `/global/sync-event`
- some prompt streaming endpoints

That prevents transport behavior from interfering with streaming latency or buffering.

## What `opencode serve` Actually Exposes

### `serve` is intentionally small

The `serve` CLI command itself is not doing heavy integration logic.

It mostly:

1. Resolves network options.
2. Starts `Server.listen(opts)`.
3. Prints the listening URL.
4. Waits forever.

This is important because it means desktop-specific behavior is not baked into the core CLI command. Desktop adds its own process supervision around a small, stable server entry point.

### `Server.listen` builds the control plane

The OpenCode server is a Hono app running on Bun.

Key behaviors:

- Basic Auth middleware when `OPENCODE_SERVER_PASSWORD` is set
- CORS allowing loopback and Tauri origins
- optional mDNS publishing for non-loopback hosts
- compression for non-streaming routes
- route composition around the control plane

The route tree includes far more than just chat:

- global
- auth
- provider
- config
- project
- path
- vcs
- session
- command
- file
- tool
- lsp
- formatter
- mcp
- agent
- tui

That is why the server contract is the real product boundary.

### Authentication model

Basic Auth is controlled by:

- `OPENCODE_SERVER_PASSWORD`
- optional `OPENCODE_SERVER_USERNAME`

If no password is set, the server warns that it is unsecured.

Desktop always sets credentials, which is the right default for a locally spawned agent server.

### CORS is explicitly desktop-aware

Server CORS allows:

- `http://localhost:*`
- `http://127.0.0.1:*`
- `tauri://localhost`
- `http://tauri.localhost`
- `https://tauri.localhost`
- some hosted `*.opencode.ai` origins
- optional extra configured CORS origins

This is a subtle but important proof that desktop is meant to be a webview client against the same server API.

## Sessions, Prompts, and Other Runtime APIs

The server exposes rich session APIs over HTTP. Examples that matter for harness design:

- `POST /session`
- `GET /session/:id/message`
- `POST /session/:id/prompt`
- `POST /session/:id/prompt_async`
- `POST /session/:id/abort`
- `POST /session/:id/fork`
- `POST /session/:id/init`
- `POST /session/:id/shell`
- permission and question reply routes

Important observations:

1. Prompt transport is session-based, not turn-based.
2. Async prompting exists as a first-class route.
3. Abort exists as a first-class route.
4. Initialization and forking are first-class session operations.
5. The desktop shell itself does not reinterpret these semantics. It simply hosts the server and lets the shared app use them.

This matters for T3 because your harness adapter will have to translate from OpenCode's session-and-message model into T3's provider abstractions.

Desktop does not have to solve that translation because its frontend is an OpenCode-native client.

## The SDK Is Generated From the Server Contract

This is probably the single strongest argument for using the server API as the harness boundary.

`packages/sdk/js/script/build.ts`:

1. runs OpenCode's OpenAPI generation from the `packages/opencode` project
2. writes `openapi.json`
3. runs `@hey-api/openapi-ts`
4. generates typed client code under `src/v2/gen`
5. formats and builds the SDK

This means:

- the SDK is downstream of the server contract
- the server is upstream of the SDK
- if you want stable programmatic integration, the server API is the source of truth

Upstream also documents this directly: when you run regular `opencode`, the TUI is a client of the server, and the same OpenAPI endpoint is used to generate the SDK.

### Why desktop does not just call `createOpencodeServer()` from the SDK

The SDK convenience function `createOpencodeServer()` is helpful, but desktop does not use it as-is.

Why:

1. It hardcodes `opencode` from PATH.
2. Desktop needs to launch a packaged `opencode-cli` binary.
3. Desktop needs WSL-specific launch behavior.
4. Desktop needs native kill semantics and startup phase reporting.
5. Desktop wants to expose credentials before health is complete.
6. Desktop needs to translate SQLite migration log lines into UX events.

That is exactly the same reason T3 Code should probably have its own OpenCode process manager instead of using the SDK's basic server helper directly.

## TUI, `run --attach`, ACP, and Desktop All Confirm the Same Pattern

Another strong signal is that multiple other upstream entry points use the same server-first idea.

### TUI

The TUI SDK context creates an SDK client with `createOpencodeClient({ baseUrl, ... })` and subscribes to SSE.

So even the TUI is implemented as a client of the server.

### `run --attach`

The CLI `run` command supports `--attach <url>`.

When attaching:

- it builds Basic Auth headers from the same env variables
- it creates an SDK client for the running server
- it drives the operation through the server API

This is extremely useful as proof that upstream already considers an externally managed server to be a first-class runtime shape.

### ACP

The ACP entry point also creates an SDK client against a running OpenCode server.

That shows even protocol bridges are meant to sit on top of the same SDK or server boundary.

### Implication

Desktop is not a special exception. It is one more client implementation on top of the same headless server.

## What Is Desktop-Specific vs What Is OpenCode-Core

### Desktop-specific concerns

These live in `packages/desktop` and `packages/desktop-electron`:

- locating the packaged sidecar binary
- optional global CLI install and sync
- WSL launching and path conversion
- child process lifecycle and kill behavior
- native splash or loading window
- translating sqlite migration logs into UI progress
- native file pickers, clipboard access, app launching, notifications, updater hooks
- storing desktop-specific settings like default server URL

### OpenCode-core concerns

These live in `packages/opencode` and the generated SDK:

- HTTP routes
- session lifecycle
- provider metadata and auth
- prompt and tool execution
- event streams
- file, path, vcs, mcp, lsp, formatter, agent APIs
- data model and OpenAPI spec

### Shared app concerns

These live in `packages/app`:

- selecting current server
- constructing SDK clients
- health gating and retry behavior
- global sync
- event buffering and coalescing
- session UI and routing
- directory-aware state projection

This three-way split is a very good reference architecture.

## Critical Design Insights for T3 Code

These are the findings that matter most for implementing an OpenCode harness here.

### 1. Use `opencode serve` as the runtime boundary

Do not build the harness around:

- parsing interactive terminal output
- driving the TUI
- trying to infer state from human-readable CLI text

Build it around:

- process lifecycle for a sidecar
- health probing
- HTTP requests
- SSE subscriptions

### 2. Separate process management from provider adaptation

Upstream desktop separates:

- native sidecar manager
- shared frontend client logic
- core server runtime

T3 should mirror this with something like:

- `OpencodeServerManager`
- typed OpenCode client wrapper
- `OpencodeAdapter` translating OpenCode semantics into T3 provider semantics

That is cleaner than embedding spawn logic in the adapter.

### 3. Readiness must mean reachable server, not installed binary

Desktop does not stop at "binary exists".

The only meaningful readiness test is:

- child spawned successfully
- `/global/health` responds successfully
- ideally provider and auth metadata are reachable too

This lines up with the direction already captured in this repo's OpenCode plan and memory.

### 4. Keep auth and base URL centralized

Upstream has a dedicated `createSdkForServer()` helper so auth, `baseUrl`, and fetch behavior are configured in one place.

T3 should do the same rather than scattering OpenCode request setup across many modules.

### 5. Expect event-stream operational work

The shared app's SSE layer is not trivial. It includes:

- heartbeat detection
- reconnects
- buffering
- coalescing
- stale delta suppression

If T3 wants stable realtime OpenCode UX, especially for streaming message parts, it should not assume a naive event loop will be enough.

### 6. Distinguish local managed server from attach mode

Upstream desktop and CLI both support externally managed servers.

So T3 can reasonably consider two modes:

1. Managed mode:
   - T3 spawns `opencode serve`
   - T3 owns lifecycle and health

2. Attached mode:
   - T3 connects to an already running server
   - T3 does not own spawn or upgrade

This can be useful for advanced users and development workflows.

### 7. The biggest semantic gap is not process control, it is model translation

Desktop does not need to translate OpenCode into another orchestration model. T3 does.

So even after you copy the desktop-side sidecar pattern, you still need to solve:

- session-centric OpenCode vs turn-centric T3
- message and part events vs T3 runtime event model
- model selection contract differences
- rollback and resume translation

Desktop proves the transport boundary. It does not solve T3's orchestration mapping problem for you.

## Recommended T3 Harness Shape

Based on upstream desktop behavior, the cleanest T3 harness shape is:

```text
T3 Provider Layer
  |
  | uses
  v
OpencodeAdapter
  |
  | uses
  v
OpencodeServerManager
  |
  | spawn and supervise
  v
opencode serve child process
  |
  | connect with typed client
  v
OpenCode HTTP + SSE API
```

Where responsibilities are split as follows:

- `OpencodeServerManager`
  - resolve binary path
  - choose port
  - generate auth
  - spawn child
  - wait for health
  - expose typed client factory
  - own teardown

- OpenCode client layer
  - set `baseUrl`
  - set auth headers
  - expose typed API calls
  - expose SSE subscription helpers

- `OpencodeAdapter`
  - create sessions
  - send prompts
  - observe events
  - translate session or message semantics into T3 runtime events
  - map interrupt, rollback, read-thread, and resume behavior into T3 contracts

This is substantially closer to upstream reality than any "run the CLI and scrape its output" approach.

## Pitfalls and Non-Obvious Details

These are the details easiest to miss on a quick read:

1. Desktop startup gives the renderer credentials before health completes.
2. The main window can appear before the sidecar is healthy.
3. `sqlite-migration:*` log lines are a special startup UX channel.
4. Basic Auth is always part of the local desktop sidecar story.
5. There are separate global and non-global SSE surfaces.
6. The shared app, not the native shell, owns most of the state-sync sophistication.
7. The SDK helper that spawns a server is too small for desktop-grade process management.
8. WSL launch support is treated as a first-class path, not a downstream hack.
9. Shell environment loading on Unix is deliberate and important for tool discovery.
10. Proxy behavior for loopback health checks can break local sidecar connectivity unless handled carefully.

## Source Files Worth Studying

These upstream files are the most useful references for implementing a harness:

- `packages/desktop/src-tauri/src/lib.rs`
- `packages/desktop/src-tauri/src/cli.rs`
- `packages/desktop/src-tauri/src/server.rs`
- `packages/desktop/src/index.tsx`
- `packages/desktop-electron/src/main/index.ts`
- `packages/desktop-electron/src/main/cli.ts`
- `packages/desktop-electron/src/main/server.ts`
- `packages/desktop-electron/src/main/ipc.ts`
- `packages/desktop-electron/src/preload/index.ts`
- `packages/desktop-electron/src/renderer/index.tsx`
- `packages/app/src/utils/server.ts`
- `packages/app/src/context/global-sdk.tsx`
- `packages/app/src/context/server.tsx`
- `packages/app/src/app.tsx`
- `packages/opencode/src/cli/cmd/serve.ts`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/server/routes/global.ts`
- `packages/opencode/src/server/routes/event.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/src/cli/cmd/run.ts`
- `packages/opencode/src/cli/cmd/tui/context/sdk.tsx`
- `packages/sdk/js/script/build.ts`
- `packages/sdk/js/src/v2/server.ts`
- `packages/sdk/js/src/v2/client.ts`
- `packages/sdk/js/src/v2/gen/sdk.gen.ts`

## Final Takeaway

If you want to reproduce OpenCode Desktop's integration style in T3 Code, the correct thing to copy is not the desktop UI or the CLI's terminal output. The thing to copy is the boundary:

- spawn a managed `opencode serve` sidecar
- secure it with Basic Auth
- wait for real health
- talk to it through typed HTTP and SSE clients
- keep process management separate from orchestration translation

That is how upstream desktop actually works under the hood.
