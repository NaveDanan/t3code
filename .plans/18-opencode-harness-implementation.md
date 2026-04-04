# Plan: OpenCode Harness Implementation

## Summary

Implement OpenCode as a first-class provider by integrating with OpenCode's documented headless server and JS SDK, replacing the current stub provider probe and adapter, enabling OpenCode in chat or orchestration and git text generation, and closing the remaining web, type, and test gaps.

The preferred runtime shape is now validated: T3 should manage an OpenCode server process or SDK-backed client session manager, not invent a raw, undocumented subprocess bridge when the product already exposes HTTP, SSE, and generated client types for external integrations.

This work must still reuse the existing provider-neutral orchestration path and the Codex or Claude reference patterns instead of introducing a parallel transport or provider-specific shortcuts.

## Goals

1. Replace the current placeholder OpenCode readiness and adapter stubs with a real runtime integration.
2. Keep all runtime traffic inside the existing provider stack:
   - `ProviderCommandReactor`
   - `ProviderService`
   - `ProviderAdapter`
   - canonical `ProviderRuntimeEvent`
3. Support both long-lived chat sessions and one-shot git text generation.
4. Keep readiness, rollback, recovery, and restart behavior explicit and deterministic.

## Non-Goals

1. Do not add provider-specific websocket channels or direct UI-to-OpenCode flows.
2. Do not silently fall back to Codex or Claude for OpenCode runtime failures or git flows.
3. Do not fake rollback or resume parity if OpenCode cannot support it correctly.

## Current State

The existing OpenCode integration is scaffolded but intentionally non-functional:

1. `apps/server/src/provider/Layers/OpencodeProvider.ts` probes `opencode --version` and then still returns an error status with the message that the sidecar bridge is not implemented yet.
2. `apps/server/src/provider/Layers/OpencodeAdapter.ts` is a full stub. `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`, `respondToUserInput`, `readThread`, and `rollbackThread` all fail with unsupported-operation errors, and `streamEvents` is empty.
3. `apps/web/src/session-logic.ts` still hardcodes OpenCode as unavailable.
4. `apps/server/src/git/Layers/RoutingTextGeneration.ts` explicitly rejects OpenCode for commit messages, PR content, branch names, and thread titles.
5. Most provider contracts already include OpenCode, but a few web and store seams still assume only Codex or Claude.

## Phase 0: Runtime Contract Findings

The main go or no-go questions are now materially answered.

Validated surfaces:

1. OpenCode exposes a documented headless HTTP server through `opencode serve`.
2. OpenCode exposes a documented JS or TS SDK through `@opencode-ai/sdk`.
3. OpenCode exposes a documented SSE event stream at `GET /event`.
4. OpenCode exposes documented session lifecycle APIs under `/session`.
5. OpenCode exposes provider and auth metadata under `/provider`, `/provider/auth`, and `/config/providers`.
6. OpenCode exposes permission and question response APIs as first-class routes.
7. OpenCode supports structured output with JSON Schema on prompt requests.

Validated live observations from a local `opencode serve` instance:

1. `GET /global/health` returns `{ healthy: true, version }`.
2. `GET /event` emits SSE frames with payloads such as `server.connected`, `message.updated`, `message.part.delta`, `message.part.updated`, `session.status`, `session.diff`, and `session.idle`.
3. `POST /session` creates a reusable session bound to a working directory.
4. `POST /session/:id/prompt_async` accepts a prompt with an explicit model object shaped like `{ providerID, modelID }`.
5. Structured output works via `format: { type: "json_schema", schema }` and returns validated data in `info.structured`, plus a `StructuredOutput` tool part.
6. `GET /question` and `GET /permission` are available and return pending requests.

Open questions that still need implementation-time validation:

1. How reliably `POST /session/:id/abort` maps to T3's current turn interruption semantics under active load.
2. How OpenCode's message-level revert model should map to T3's `rollbackThread(threadId, numTurns)` contract.
3. Whether T3 should persist raw OpenCode session IDs directly as resume state or wrap them in an adapter-owned cursor shape.

## Phase 1: Server or SDK Boundary and Dependency Strategy

Define how T3 Code will talk to OpenCode using the documented external integration path.

1. Prefer the official JS or TS SDK by adding `@opencode-ai/sdk` in `apps/server/package.json`, unless a direct HTTP client keeps the integration meaningfully smaller.
2. Launch and manage `opencode serve` as the runtime boundary when T3 owns the OpenCode process lifecycle.
3. If the user already runs an external OpenCode server, consider whether T3 should optionally attach instead of always spawning its own instance.
4. Introduce a T3-owned OpenCode session manager layer that owns:
   - process spawn for `opencode serve` when T3 manages the runtime
   - server readiness and health checks
   - SDK or HTTP client construction
   - SSE subscription and event fan-out
   - shutdown and cleanup
   - reconnect and resume hooks
5. Keep this manager separate from the adapter so `OpencodeAdapter` continues to implement `ProviderAdapterShape` rather than embedding raw process or HTTP control.
6. Treat ACP as a secondary integration path. It is documented and uses JSON-RPC over stdio, but it is primarily editor-facing. The headless server and SDK are a better fit for a Node server like T3.

Reference implementations and comparisons:

1. `apps/server/src/codexAppServerManager.ts`
2. `apps/server/src/provider/Layers/CodexAdapter.ts`
3. `apps/server/src/provider/Layers/ClaudeAdapter.ts`

## Phase 2: Real Provider Readiness

Replace the placeholder OpenCode provider status with a real readiness probe in `apps/server/src/provider/Layers/OpencodeProvider.ts`.

Expected behavior:

1. Continue to report disabled when the provider is disabled in settings.
2. Report not installed when the CLI is missing.
3. Report run failure when the CLI exists but the probe fails.
4. Report version, auth, capabilities, and available models when the provider is actually usable.
5. Only report a ready or healthy status when T3 can initialize or reach the OpenCode server bridge, not merely when `opencode --version` succeeds.

Implementation notes:

1. Reuse `makeManagedServerProvider` for status refresh and settings-driven updates.
2. Replace the current version-only CLI probe with a real readiness sequence built around `opencode serve`, `GET /global/health`, `GET /provider`, `GET /provider/auth`, and `GET /config/providers`.
3. Keep probe output aligned with the shared `ServerProvider` contract.
4. Update `apps/server/src/provider/Layers/ProviderRegistry.test.ts` so it no longer asserts that OpenCode must stay unavailable until a bridge exists.

## Phase 3: Canonical OpenCode Adapter

Replace the stub in `apps/server/src/provider/Layers/OpencodeAdapter.ts` with a real provider adapter built on top of the new session manager.

Required adapter support:

1. `startSession`
2. `sendTurn`
3. `interruptTurn`
4. `respondToRequest`
5. `respondToUserInput`
6. `stopSession`
7. `listSessions`
8. `hasSession`
9. `readThread`
10. `rollbackThread`
11. `stopAll`
12. `streamEvents`

Adapter requirements:

1. Translate OpenCode-native events into canonical `ProviderRuntimeEvent` values.
2. Preserve raw payloads for debugging.
3. Expose a stable `ProviderSession` shape with OpenCode session id, selected model, runtime mode, status, last error, and opaque resume cursor.
4. Keep model-switch capabilities explicit through adapter capabilities instead of ad hoc provider checks elsewhere.

Important contract mismatch to resolve:

1. T3's current OpenCode contracts assume a model slug like `openai/gpt-5` under provider `opencode`.
2. The validated OpenCode server contract expects model selection as `{ providerID, modelID }`, where those IDs come from OpenCode's own provider catalog.
3. Phase 3 must therefore either redesign T3's OpenCode model-selection contract or add a translation layer from T3's persisted selection into an OpenCode-native provider or model pair.

Primary reference contracts:

1. `apps/server/src/provider/Services/ProviderAdapter.ts`
2. `packages/contracts/src/provider.ts`

## Phase 4: Orchestration, Persistence, and Recovery

Harden the existing orchestration path against OpenCode-specific runtime behavior.

Key areas:

1. Validate that `ProviderCommandReactor.ensureSessionForThread` handles OpenCode model and runtime-mode restarts correctly.
2. Persist the correct resume cursor and runtime payload through `ProviderSessionDirectory`.
3. Confirm `ProviderService` can recover and rehydrate OpenCode sessions after server restart.
4. Define how `readThread` and `rollbackThread` map to OpenCode-native history or checkpoint capabilities.
5. If exact rollback parity is impossible, make that an explicit capability or error decision before enabling checkpoint-driven rollback UX.

Implementation note:

1. OpenCode appears to be session-centric and message-part-centric rather than turn-centric. T3 will need explicit adapter logic to derive turn lifecycle from OpenCode session status, assistant messages, and part events.
2. OpenCode exposes `session.diff`, `session.revert`, and message history APIs, but they are message-oriented. T3's turn rollback semantics should not assume a one-to-one match.

Relevant files:

1. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
2. `apps/server/src/provider/Layers/ProviderService.ts`
3. `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`

## Phase 5: Web Enablement Without Provider-Specific Drift

Enable OpenCode in the web app using the existing generic provider flow.

Required changes:

1. Remove the static OpenCode `available: false` fence in `apps/web/src/session-logic.ts`.
2. Keep live readiness driven by `providerStatuses` instead of hardcoded availability.
3. Patch the remaining stale model-selection helpers that still narrow support to Codex and Claude only.
4. Validate provider selection, locked-provider behavior, persisted draft restoration, and settings status copy.

Known seam to fix:

1. `apps/web/src/store.ts` still narrows model-selection normalization to Codex or Claude only.

Relevant files:

1. `apps/web/src/session-logic.ts`
2. `apps/web/src/store.ts`
3. `apps/web/src/components/chat/ProviderModelPicker.tsx`
4. `apps/web/src/components/settings/SettingsPanels.tsx`

Additional contract work:

1. Revisit `packages/contracts/src/model.ts` and related OpenCode model defaults. The current built-in OpenCode model list is likely wrong for the validated server path because OpenCode models come from `/config/providers` and are keyed by OpenCode provider or model IDs, not T3's hardcoded `openai/*` slugs.

## Phase 6: OpenCode Git Text Generation

Add OpenCode support to git text generation instead of leaving it explicitly unsupported.

Required work:

1. Replace the unsupported-provider branches in `apps/server/src/git/Layers/RoutingTextGeneration.ts`.
2. Add a dedicated OpenCode text-generation layer for:
   - commit message generation
   - PR content generation
   - branch name generation
   - thread title generation
3. Use the validated OpenCode server prompt contract with `format: { type: "json_schema", schema }` so structured output comes back in `info.structured`.
4. Follow the existing Codex and Claude patterns for timeout handling, provider-specific error normalization, and explicit model handling.
5. Reuse the same OpenCode session manager or client boundary where practical. A separate raw CLI harness is no longer the preferred path for git flows.

Reference implementations:

1. `apps/server/src/git/Layers/CodexTextGeneration.ts`
2. `apps/server/src/git/Layers/ClaudeTextGeneration.ts`

## Phase 7: Tests, Type Seams, and Rollout Hardening

Add or update tests across server and web.

Server coverage:

1. OpenCode provider probe states.
2. Session manager lifecycle.
3. Canonical event translation.
4. Adapter behavior.
5. Recovery behavior.
6. Read-thread and rollback semantics.
7. RoutingTextGeneration behavior.

Web coverage:

1. Provider picker availability.
2. Settings readiness and status rendering.
3. Persisted model-selection and draft restoration.

Type and source cleanup:

1. Invert or replace tests that currently assert OpenCode is unimplemented.
2. Close the remaining source-level type narrowing in the web store and any other compile-time assumptions discovered during implementation.

## Verification

Targeted verification:

1. Run targeted server tests for the OpenCode provider probe, session manager, adapter, recovery paths, and RoutingTextGeneration behavior from `apps/server`.
2. Run targeted web tests for provider picker availability, settings status rendering, and persisted model-selection behavior.

Repository completion gates:

1. `bun fmt`
2. `bun lint`
3. `bun typecheck`
4. `bun run test` for the affected packages after targeted suites are stable

Manual end-to-end verification:

1. Enable OpenCode in settings.
2. Confirm a ready status with version and auth details.
3. Start a new OpenCode thread.
4. Complete at least one streamed turn.
5. Handle approval prompts.
6. Handle structured user-input prompts.
7. Interrupt a turn.
8. Restart the server and resume the session.
9. Exercise read-thread or rollback behavior.
10. Generate commit message, PR content, branch name, and thread title through OpenCode.
11. Verify structured-output responses are parsed from the OpenCode server result shape rather than hand-parsed from plain text.

## Decisions

1. Included scope: full OpenCode chat or orchestration harness plus git text generation.
2. Recommended harness shape: a T3-owned OpenCode session-manager layer built on the documented OpenCode server and JS SDK.
3. Architectural boundary: keep all provider traffic flowing through `ProviderCommandReactor` -> `ProviderService` -> `ProviderAdapter` -> canonical `ProviderRuntimeEvent`.
4. Readiness rule: OpenCode should not be marked available merely because `opencode --version` works; readiness must reflect whether T3 can actually start and manage an OpenCode session.
5. Rollout rule: do not silently fall back to Codex or Claude for OpenCode git flows or failed OpenCode runtime operations.
6. Transport decision: prefer the documented server or SDK boundary over ACP for the initial T3 integration.
7. Model decision: T3 must explicitly reconcile its current OpenCode model-selection schema with OpenCode's native `{ providerID, modelID }` model contract.

## Relevant Files

1. `apps/server/src/provider/Layers/OpencodeProvider.ts` — replace the hardcoded sidecar-not-implemented status path with real readiness, auth, capability, and model probing.
2. `apps/server/src/provider/Layers/OpencodeAdapter.ts` — replace the unsupported-operation stub with the full adapter implementation.
3. `apps/server/src/provider/Services/ProviderAdapter.ts` — reference contract for adapter methods, capabilities, and canonical event streaming.
4. `apps/server/src/provider/Layers/ProviderService.ts` — recovery, runtime event publication, and persisted runtime payload handling.
5. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — session start or restart rules and provider or model invariants.
6. `apps/server/src/provider/Layers/CodexAdapter.ts` — reference for canonical event mapping, queueing, and adapter lifecycle.
7. `apps/server/src/codexAppServerManager.ts` — reference for long-lived process lifecycle, request correlation, and shutdown semantics.
8. `apps/server/src/provider/Layers/ClaudeAdapter.ts` — reference for approval or user-input bridging and non-Codex canonical event translation.
9. `apps/server/src/git/Layers/RoutingTextGeneration.ts` — replace explicit OpenCode unsupported branches.
10. `apps/server/src/git/Layers/CodexTextGeneration.ts` — reference for one-shot CLI invocation, timeout handling, and structured output validation.
11. `apps/server/src/git/Layers/ClaudeTextGeneration.ts` — reference for structured JSON output execution.
12. `apps/web/src/session-logic.ts` — remove the static OpenCode availability fence.
13. `apps/web/src/store.ts` — widen the remaining Codex-or-Claude-only model-selection normalization.
14. `apps/web/src/components/chat/ProviderModelPicker.tsx` — validate live readiness gating and locked or unlocked provider behavior with OpenCode enabled.
15. `apps/web/src/components/settings/SettingsPanels.tsx` — validate status, auth copy, refresh behavior, and settings presentation.
16. `apps/server/src/provider/Layers/ProviderRegistry.test.ts` — replace placeholder OpenCode-unavailable assertions with real readiness expectations.
17. `packages/contracts/src/model.ts` — revisit OpenCode model defaults and selection shape.
18. `packages/contracts/src/provider.ts` — revisit how OpenCode model selection and resume state should be represented.
19. `apps/server/package.json` — likely add `@opencode-ai/sdk`.

Likely new files:

1. An OpenCode session manager service or layer under `apps/server/src/provider`.
2. An OpenCode HTTP or SDK client wrapper under `apps/server/src/provider`.
3. An OpenCode git text-generation layer under `apps/server/src/git/Layers`.
4. Focused tests covering all three additions.

## Further Considerations

1. If OpenCode does not expose a stable machine-readable streaming contract for approvals, resume, and history management, stop and revise the implementation shape before coding instead of forcing brittle parsing into the provider stack.
2. Phase 0 now suggests the opposite of the original assumption: the documented server or SDK contract is probably the right primary integration, and a raw custom subprocess protocol should be avoided unless the server path proves insufficient during implementation.
3. If OpenCode rollback or history semantics differ materially from Codex and Claude, prefer an explicit capability or error model over fake parity.
4. OpenCode's model routing is multi-provider by design. T3 needs to decide whether its OpenCode UX exposes that underlying provider or model structure directly or constrains it behind a simpler curated mapping.