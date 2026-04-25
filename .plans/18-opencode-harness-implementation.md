# OpenCode Harness Implementation

This document is the current implementation reference for OpenCode in NJ Code.

It replaces the old phase-by-phase plan. The goal here is not to track unfinished tasks. The goal is to explain how OpenCode actually works in this repository today, why it is shaped this way, which upstream facts matter, which invariants already bit us, and where the integration is still intentionally constrained.

## Current Truth

- OpenCode is a real provider in NJ Code. It is not a placeholder or disabled stub anymore.
- T3 does not automate the interactive OpenCode TUI and does not parse terminal transcripts.
- T3 manages a local `opencode serve` process and talks to it through `@opencode-ai/sdk/v2`.
- Chat uses long-lived OpenCode sessions plus the global SSE event stream.
- Git text generation reuses the same managed server and model-resolution path, but uses short-lived one-shot sessions.
- The web app treats OpenCode as a normal provider through the shared provider, model, and capability abstractions.
- T3 currently supports only the managed-local-server mode. There is no attach-to-existing-server or custom remote harness URL support.

## The Mental Model

The important architecture is:

```text
NJ server
  -> OpencodeServerManager
  -> launches `opencode serve`
  -> builds SDK client against loopback HTTP
  -> probes health, auth, and provider catalog
  -> subscribes to OpenCode global SSE events
  -> OpencodeAdapter translates OpenCode session/message/part behavior
  -> canonical ProviderRuntimeEvent stream
  -> existing orchestration, persistence, and web flows
```

This is the key point: OpenCode is integrated by translation, not by creating a second orchestration model.

OpenCode itself is session-centric and message-part-centric. T3 is turn-centric and provider-neutral. The adapter layer is the bridge between those worlds.

## Upstream Facts That Shape The Implementation

Several upstream OpenCode facts matter more than anything else:

- The real external boundary is the OpenCode server, not the interactive CLI transcript.
- Upstream desktop shells also treat OpenCode as a managed `serve` sidecar and connect over HTTP and SSE through the generated SDK.
- The TUI is also effectively a client of the server.
- The server contract is typed and stable enough to build against directly.
- OpenCode models are multi-provider. An OpenCode session might use OpenAI, Anthropic, or another upstream provider even though T3 only sees the top-level provider as `opencode`.
- OpenCode reasoning variants are model-specific and can be richer than a tiny fixed enum.
- OpenCode messages and parts are first-class entities. Turns are something T3 has to reconstruct.

Those facts are the reason the integration uses:

- a managed `opencode serve` process
- SDK calls instead of transcript parsing
- live provider-catalog resolution for models
- an adapter that derives turn lifecycle from session, message, and part events

## High-Level Component Map

The OpenCode implementation is spread across a few focused pieces.

### `apps/server/src/provider/Layers/OpencodeServerManager.ts`

Owns local process lifecycle and SDK connectivity.

### `apps/server/src/provider/Layers/OpencodeProvider.ts`

Owns readiness, auth summary, model discovery, and capability mapping for provider status.

### `apps/server/src/provider/opencode.ts`

Owns shared SDK-result decoding and model-resolution helpers.

### `apps/server/src/provider/Layers/OpencodeAdapter.ts`

Owns chat session lifecycle, event translation, approvals, user input, interrupt, read-thread, and rollback.

### `apps/server/src/git/Layers/OpencodeTextGeneration.ts`

Owns one-shot structured generation for commit messages, PR content, branch names, and thread titles.

### Web and contracts

These files make OpenCode behave like a normal provider in the UI:

- `packages/contracts/src/model.ts`
- `packages/contracts/src/settings.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/components/chat/composerProviderRegistry.tsx`
- `apps/web/src/components/chat/TraitsPicker.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`

## Server Runtime Boundary

T3 currently launches OpenCode like this in principle:

```text
opencode serve --hostname=127.0.0.1 --port=<ephemeral-port>
```

Important details of the current manager behavior:

- It binds only to loopback.
- It picks an ephemeral port itself.
- It waits for `global.health` before considering the server usable.
- It reuses a healthy managed server for repeated probes and requests.
- It restarts the managed server if the configured binary path changes.
- It replaces the managed server if the old process exits or stops passing health checks.
- It exposes a reconnecting SSE stream over `global.event`.
- On Windows it uses `shell: true` for spawn and `taskkill /T /F` for teardown.

This is similar to upstream OpenCode desktop in spirit, but not identical in every operational detail.

Important difference from upstream desktop:

- Upstream desktop wraps its sidecar with per-launch Basic Auth and packaged-binary logic.
- T3 currently does not add that auth wrapper.
- T3 instead relies on a local loopback server started from the configured OpenCode binary path.

## Provider Readiness And Status

OpenCode readiness is not defined as "the binary exists".

T3 treats OpenCode as ready only when it can actually start the bridge and query live metadata from it.

The readiness flow is:

1. Read `providers.opencode` settings.
2. If disabled, stop any managed server and report the provider as disabled.
3. If enabled, ask the server manager to `probe` the OpenCode bridge.
4. The probe ensures the server is running and then queries:
   - `config.providers`
   - `provider.list`
   - `provider.auth`
5. Build the provider snapshot from the live result.

The resulting status behavior is:

- Disabled provider: status is disabled and the bridge is stopped.
- Missing binary: status is error and `installed` is false.
- Non-ENOENT bridge failure: status is error and `installed` is true.
- Connected upstream providers: auth is `authenticated` with a label.
- No connected providers but auth methods exist: auth is `unauthenticated`.
- No connected providers and no auth methods: auth is `unknown`.

The auth summary is intentionally based on real OpenCode provider state, not on a T3-local guess.

## Model Discovery And Capability Mapping

OpenCode model discovery is live, not fully hardcoded.

The provider probe builds the visible model list from `configuredProviders` returned by OpenCode. Each discovered model becomes a T3 slug shaped like:

```text
<providerID>/<modelID>
```

Examples:

- `openai/gpt-5`
- `anthropic/claude-sonnet-4-5`

T3 still keeps a tiny fallback built-in list for OpenCode so the UI has something predictable when the live provider catalog is unavailable:

- `openai/gpt-5`
- `openai/gpt-5-mini`

### Capability Mapping

The most important capability mapping is reasoning effort.

Current behavior:

- If a discovered OpenCode model is not reasoning-capable, T3 gives it no effort controls.
- If a reasoning-capable model exposes OpenCode `variants`, T3 uses those variants directly to build `reasoningEffortLevels`.
- If the model is an OpenAI GPT-5 reasoning model but exposes no variants, T3 falls back to `low`, `medium`, and `high`.
- Labels are normalized for the UI, for example:
  - `xhigh` -> `Extra High`
  - `minimal` -> `Minimal`
  - `none` -> `None`

This is a deliberate improvement over the old hardcoded `low|medium|high` shape.

### Important Contract Tradeoff

There is still a split between runtime capability flexibility and persisted contract shape.

- Runtime capabilities can now reflect live model variants from OpenCode.
- Persisted OpenCode effort typing in T3 currently centers on the OpenAI-style set:
  - `none`
  - `minimal`
  - `low`
  - `medium`
  - `high`
  - `xhigh`

That means the UI can be more dynamic than the long-term persistence contract. If upstream OpenCode starts exposing additional variants that matter for T3, the contract layer will need another widening pass.

## Model Resolution: Slug vs Native Model Tuple

This is one of the most important implementation details.

T3 persists OpenCode model selections as slugs like `openai/gpt-5`. OpenCode prompt APIs expect a native object:

```ts
{ providerID, modelID }
```

T3 bridges that mismatch in `apps/server/src/provider/opencode.ts`.

Resolution strategy:

1. If the T3 slug is already `provider/model`, try an exact match against `configuredProviders`.
2. If that fails, try a unique bare-model match across providers.
3. If that fails, check whether the chosen bare model is the default model for exactly one provider.
4. For fallback flows, prefer the requested provider if present, then use that provider's default model, then its first configured model.

This is why the T3-facing OpenCode model shape can stay simple while the server-side request still uses the live provider catalog.

It is also why OpenCode support in this repository is not just "another provider enum value". The top-level provider is `opencode`, but the actual routed model is still resolved through OpenCode's own provider graph.

## Chat Session Lifecycle

The chat path lives in `OpencodeAdapter`.

### Session Start

`startSession` does one of two things:

1. If T3 has a persisted resume cursor, it calls `session.get` and reattaches to the existing OpenCode session.
2. Otherwise it calls `session.create` with the target working directory.

The adapter persists an opaque resume cursor shaped like:

```ts
{
  sessionId: string
  cwd: string
}
```

That cursor belongs to the adapter contract, not to the UI.

When a session starts successfully, the adapter also emits canonical session/thread lifecycle events such as:

- `session.started`
- `thread.started`
- `session.configured`
- `session.state.changed`

### Session State In Memory

For each active thread, the adapter keeps an in-memory context containing:

- the current `ProviderSession`
- the OpenCode session id
- cwd
- active turn state
- pending approval requests
- pending user-input requests
- message-role and parent metadata
- part cache
- started/completed item tracking
- current-turn activity markers

The adapter also keeps a reverse map from OpenCode `sessionID` back to T3 `threadId` so the global event stream can be routed correctly.

### Turn Send

`sendTurn` does the following:

1. Validates that the selected provider is `opencode`.
2. Rejects the request if another turn is already running.
3. Ensures the managed OpenCode server is healthy.
4. Builds prompt parts from text plus optional attachments.
5. Resolves the selected OpenCode model slug against the live provider catalog.
6. Extracts the selected effort option as the OpenCode `variant`.
7. If T3 is in plan mode, sets `agent: "plan"`.
8. Calls `session.promptAsync`.

OpenCode supports in-session model switching, so the adapter advertises:

```text
sessionModelSwitch: in-session
```

That matches the implementation: the resolved model tuple can be passed on a prompt without rebuilding the session.

## A Critical Upstream Invariant: Message IDs Must Be Provider-Native

One of the hardest bugs in this integration came from message IDs.

Upstream OpenCode compares message IDs lexicographically when deciding whether a resumed session needs a fresh assistant response. That means new user message IDs have to preserve the provider's ascending ordering behavior.

T3 originally generated OpenCode user message IDs as UUID-shaped values such as `msg-<uuid>`. That was good enough to look plausible, but it was not provider-native and it did not preserve the ordering assumptions used upstream.

The failure mode was subtle:

- first turn worked
- resumed session existed
- second prompt was accepted
- OpenCode immediately went idle
- no assistant response was generated

The fix was to generate provider-native ascending `msg_...` ids instead.

That logic now lives in `createOpencodeMessageId()` and is not optional. This is a real interoperability requirement, not a cosmetic naming choice.

## Event Translation And Turn Reconstruction

OpenCode emits session events, message events, and part events. T3 needs canonical runtime events and a predictable turn lifecycle.

The adapter translates the OpenCode stream into T3's provider-neutral event model.

### Event Subscription Model

- The adapter subscribes to the manager's reconnecting global event stream.
- One subscription is shared per active OpenCode binary path.
- Each incoming event is routed by OpenCode `sessionID` back to the owning T3 thread.
- Raw OpenCode payloads are preserved on canonical events as `opencode.sdk.event` for debugging.

### Session-Level Translation

Important mappings include:

- `session.created` and `session.updated`
  - update cwd and title metadata
- `session.status busy`
  - marks the T3 session as running only if there is an active live turn
- `session.status retry`
  - becomes `runtime.warning`
- `session.idle`
  - completes or aborts the active turn if there is enough evidence that the current turn actually did work
- `session.compacted`
  - becomes `thread.state.changed` with `compacted`
- `session.diff`
  - becomes `turn.diff.updated`
- `session.error`
  - becomes `runtime.error` plus a failed turn outcome

### Message-Level Translation

OpenCode replays message updates from history, so the adapter cannot accept every `message.updated` blindly.

The adapter tracks message role and assistant parent relationships in memory.

Key rules:

- user `message.updated` is accepted only if it matches the current turn's registered user message id
- replayed user messages from older turns are ignored
- assistant `message.updated` is accepted only if it belongs to the current active turn's parent chain
- historical assistant messages are ignored even if they arrive during the current turn

This prevents old history from corrupting the active turn.

### Part-Level Translation

OpenCode parts are mapped into canonical content and item events.

Supported part categories include:

- assistant text
- reasoning text
- tool execution state

The adapter emits:

- `item.started`
- `content.delta`
- `item.completed`

Tool parts are classified heuristically into T3 item types such as:

- command execution
- file change
- dynamic tool call
- web search
- collaborative agent call

## Hard-Won Lifecycle Guards

Several subtle guards now exist because OpenCode's event stream is noisier than a simple request/response flow.

### Guard 1: User text-part replay must not look like assistant output

OpenCode can replay text-part events for user-authored messages. Without role tracking, T3 can accidentally re-project the prompt as assistant output.

The adapter now records message roles from `message.updated` and refuses to bind user text parts to the active assistant item.

### Guard 2: Busy status must not re-enter running after a turn is already done

OpenCode can emit `session.status busy` after the assistant response is effectively over.

The adapter now promotes `busy` to canonical running state only while an active live turn still exists.

### Guard 3: Stale `session.idle` must not complete the next turn immediately

OpenCode can emit a replayed or late idle right after a new prompt starts.

The adapter therefore tracks `hasCurrentTurnActivity` and refuses to complete a turn on idle until real current-turn evidence exists.

Current-turn evidence includes accepted assistant, reasoning, tool, diff, approval, question, or todo activity. It does not include the echoed current user message by itself.

## Plan Mode, Approvals, And User Input

OpenCode fits plan-mode and interactive requests into the same canonical flow.

### Plan Mode

When T3 sends a turn in plan mode:

- `session.promptAsync` is called with `agent: "plan"`
- assistant text is accumulated as proposed-plan markdown
- `todo.updated` becomes `turn.plan.updated`
- duplicate todo updates are collapsed using a fingerprint
- on successful completion, the accumulated plan markdown is emitted as `turn.proposed.completed`

### Approvals

OpenCode `permission.asked` and `permission.replied` are mapped into canonical request events.

Decision mapping is:

- T3 `accept` -> OpenCode `once`
- T3 `acceptForSession` -> OpenCode `always`
- T3 `decline` or `cancel` -> OpenCode `reject`

### Structured User Input

OpenCode `question.asked`, `question.replied`, and `question.rejected` are bridged into canonical user-input events.

T3 stores the pending question set, then on response:

- non-empty answers -> `question.reply`
- all-empty answers -> `question.reject`

This keeps OpenCode question semantics aligned with T3's existing user-input contract.

## Reading Threads And Rolling Back

OpenCode does not expose a native T3 turn history. The adapter reconstructs thread state from messages.

### Read Thread

`readThread` fetches session messages and groups them into synthetic turns by user-message and assistant-parent relationships.

The reconstructed snapshot uses synthetic snapshot turn IDs shaped like:

```text
opencode-turn:<userMessageId>
```

This is different from the random live turn IDs used while a turn is actively running. That difference is expected because OpenCode has message history, not provider-native turn objects.

### Rollback

`rollbackThread(numTurns)` is implemented as best-effort message-boundary rollback:

1. Refuse rollback while a turn is still running.
2. Fetch messages.
3. Find the latest user message.
4. Call `session.revert(messageID)`.
5. Repeat once per requested turn.
6. Return a freshly reconstructed thread snapshot.

This works, but it is not exact checkpoint parity with providers that have cleaner turn-level rollback semantics.

The right mental model is:

- OpenCode rollback is supported
- OpenCode rollback is message-oriented
- OpenCode rollback should be treated as best-effort rather than perfect turn-checkpoint symmetry

## Recovery And Persistence

OpenCode recovery relies on both adapter state and T3 persistence.

Important behavior:

- The adapter's live session maps are in-memory only.
- Durable restart behavior comes from persisted provider runtime state owned by the normal T3 provider session infrastructure.
- The persisted runtime state includes provider, cwd, runtime mode, model selection, and the adapter-owned resume cursor.
- After a NJ server restart, `ProviderService` can start a fresh OpenCode adapter instance, feed it the persisted resume cursor, and continue routing `sendTurn` through the recovered session.

This is the reason the resume cursor is adapter-owned rather than a raw UI concern.

## Git Text Generation

OpenCode also powers one-shot structured text generation for git workflows.

This is implemented in `apps/server/src/git/Layers/OpencodeTextGeneration.ts`.

Supported flows are:

- commit message generation
- PR title/body generation
- branch name generation
- thread title generation

The execution pattern is:

1. Ensure the managed OpenCode server exists.
2. Probe the live provider catalog.
3. Resolve the chosen T3 slug into OpenCode `{ providerID, modelID }`.
4. Create a temporary OpenCode session in the target cwd.
5. Call `session.prompt` with:
   - prompt text
   - optional attachments
   - optional `variant` from OpenCode effort
   - `format: { type: "json_schema", schema }`
6. Decode `info.structured` against the requested schema.
7. Sanitize the generated result.
8. Delete the temporary session.

Important implications:

- Git generation reuses the same model-resolution logic as chat.
- It does not invent a second OpenCode integration path.
- Structured output is first-class, not something T3 scrapes from plain text.

## Web And UX Integration

OpenCode is integrated into the web app through the same generic provider flow used by Codex and Claude.

### Session Logic

`apps/web/src/session-logic.ts` includes `opencode` as a normal provider option. Availability is no longer hardcoded as false.

### Composer State And Draft Persistence

`apps/web/src/composerDraftStore.ts` persists OpenCode model selections and effort options under the normal per-provider draft model-selection structure.

Important restoration behavior:

- valid OpenCode effort values are restored
- invalid OpenCode effort values are dropped during rehydration
- OpenCode draft state coexists with Codex and Claude provider options in the same consolidated model-selection storage shape

### Traits And Capability-Driven UI

`apps/web/src/components/chat/composerProviderRegistry.tsx` and `TraitsPicker.tsx` use the shared capability helpers rather than hardcoding OpenCode UI separately.

That means:

- OpenCode effort controls appear only when the selected model exposes reasoning effort levels
- the default effort is taken from model capabilities
- unsupported effort values are normalized away before dispatch
- OpenCode now behaves like Codex and Claude in the traits system, but with its own capability set

### Settings

OpenCode settings are intentionally small right now:

- `enabled`
- `binaryPath`
- `customModels`

Status rendering in the settings UI is mostly provider-generic. OpenCode participates in the same headline/detail/status-dot rendering used for the other providers.

## What T3 Does Not Currently Do

These limits are important because they define the real scope of the current implementation.

- T3 does not attach to an existing external or remote OpenCode server.
- T3 does not expose a custom OpenCode server URL setting.
- T3 does not mirror every upstream desktop hardening step such as desktop-style Basic Auth wrapping or bundled sidecar distribution.
- T3 does not project the full live OpenCode model graph into contracts everywhere; it still keeps a slug-based abstraction at the edges.
- T3 does not claim exact rollback parity with providers that have stronger turn-native history semantics.

## Known Tensions And Open Design Questions

The implementation works, but a few architectural tensions are still real.

### Slug Contract vs Native Model Tuple

The current slug abstraction is practical, but it still hides a richer upstream model identity. If OpenCode model routing becomes more complex in T3, the current abstraction may eventually need to evolve.

### Runtime Capabilities vs Persisted Effort Typing

Live server capabilities can already be more dynamic than the persisted OpenCode effort union. If T3 needs to preserve additional upstream variants across reloads, the contract layer will need to widen again.

### Rollback Semantics

The current rollback implementation is useful, but it is still message-oriented rather than perfectly turn-native. That should stay an explicit mental model for future checkpoint or undo UX work.

### External-Server Support

There is currently no attach-to-existing-server mode. That is a product decision, not an accidental omission in one file.

## Important Files

- `apps/server/src/provider/Layers/OpencodeServerManager.ts`
- `apps/server/src/provider/Services/OpencodeServerManager.ts`
- `apps/server/src/provider/Layers/OpencodeProvider.ts`
- `apps/server/src/provider/opencode.ts`
- `apps/server/src/provider/Layers/OpencodeAdapter.ts`
- `apps/server/src/git/Layers/OpencodeTextGeneration.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/components/chat/composerProviderRegistry.tsx`
- `apps/web/src/components/chat/TraitsPicker.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `packages/contracts/src/model.ts`
- `packages/contracts/src/settings.ts`

## Test Coverage That Matters

The OpenCode implementation is not just documented. It has focused coverage in the areas that are most likely to regress.

Current coverage includes:

- provider readiness and auth-summary behavior
- server-manager reuse, restart, and SSE reconnect behavior
- adapter model resolution
- resumed-session startup
- second-turn behavior after resume
- parent-message remapping for assistant events
- busy/idle noise handling
- interrupt flow
- approval flow
- structured user-input flow
- read-thread and rollback behavior
- provider-service restart and rehydration behavior
- git text-generation structured output flows
- draft restoration and traits behavior in the web app

That coverage is important because many of the hardest OpenCode bugs were not syntax bugs. They were lifecycle and event-ordering bugs.

## Bottom Line

The right way to understand OpenCode in NJ Code is:

- OpenCode is integrated through its documented server and SDK.
- T3 owns the local OpenCode process lifecycle.
- T3 resolves OpenCode models against the live provider catalog instead of guessing.
- T3 translates OpenCode's session/message/part model back into canonical provider events.
- Chat, approvals, user input, rollback, recovery, and git generation all share the same OpenCode foundation.
- The integration is real and production-shaped, but it still has a few explicit limits that future work should treat as design decisions, not accidents.
