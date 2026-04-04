# Plan: OpenCode Harness Implementation

## Summary

Implement OpenCode as a first-class provider by adding a T3-owned sidecar or session manager around the OpenCode CLI, replacing the current stub provider probe and adapter, enabling OpenCode in chat or orchestration and git text generation, and closing the remaining web, type, and test gaps.

This work must reuse the existing provider-neutral orchestration path and the Codex or Claude reference patterns instead of introducing a parallel transport or provider-specific shortcuts.

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

## Phase 0: Runtime Contract Validation

Before implementation, validate the supported OpenCode runtime contract.

Required confirmations:

1. Long-lived session startup and shutdown.
2. Machine-readable event streaming.
3. Interrupt support.
4. Approval requests and approval responses.
5. Structured user-input prompts and responses.
6. Resume or reconnect semantics.
7. Auth or account inspection.
8. Model override behavior.
9. Thread history reads.
10. Rollback or checkpoint semantics.
11. One-shot structured-output support for git text generation.

This is a hard go or no-go checkpoint. The repo currently has no OpenCode SDK dependency or protocol notes, only a CLI version probe, so the rest of the plan depends on a verified machine-readable contract.

## Phase 1: Bridge Boundary and Dependency Strategy

Define how T3 Code will talk to OpenCode.

1. If OpenCode exposes a supported SDK or structured protocol client, add that dependency in `apps/server/package.json`.
2. Otherwise, add a thin internal process-protocol client that owns raw subprocess communication.
3. In either case, introduce a T3-owned OpenCode session manager layer that owns:
   - process spawn
   - handshake
   - streaming I/O
   - request correlation
   - shutdown and cleanup
   - resume hooks
4. Keep this manager separate from the adapter so `OpencodeAdapter` continues to implement `ProviderAdapterShape` rather than embedding raw child-process control.

Reference implementations:

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
5. Only report a ready or healthy status when T3 can initialize the OpenCode bridge, not merely when `opencode --version` succeeds.

Implementation notes:

1. Reuse `makeManagedServerProvider`, `spawnAndCollect`, and the Codex or Claude status patterns.
2. Keep probe output aligned with the shared `ServerProvider` contract.
3. Update `apps/server/src/provider/Layers/ProviderRegistry.test.ts` so it no longer asserts that OpenCode must stay unavailable until a bridge exists.

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
3. Expose a stable `ProviderSession` shape with provider thread id, model, runtime mode, status, last error, and opaque resume cursor.
4. Keep model-switch capabilities explicit through adapter capabilities instead of ad hoc provider checks elsewhere.

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

## Phase 6: OpenCode Git Text Generation

Add OpenCode support to git text generation instead of leaving it explicitly unsupported.

Required work:

1. Replace the unsupported-provider branches in `apps/server/src/git/Layers/RoutingTextGeneration.ts`.
2. Add a dedicated OpenCode text-generation layer for:
   - commit message generation
   - PR content generation
   - branch name generation
   - thread title generation
3. Follow the existing Codex and Claude patterns for:
   - one-shot prompt execution per operation
   - structured schema validation
   - timeout handling
   - provider-specific error normalization
   - explicit model handling
4. Keep git text generation separate from the long-lived chat-session manager unless the supported OpenCode transport clearly justifies shared runtime code.

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

## Decisions

1. Included scope: full OpenCode chat or orchestration harness plus git text generation.
2. Recommended harness shape: a T3-owned OpenCode sidecar or session-manager layer wrapping the OpenCode CLI or supported protocol client.
3. Architectural boundary: keep all provider traffic flowing through `ProviderCommandReactor` -> `ProviderService` -> `ProviderAdapter` -> canonical `ProviderRuntimeEvent`.
4. Readiness rule: OpenCode should not be marked available merely because `opencode --version` works; readiness must reflect whether T3 can actually start and manage an OpenCode session.
5. Rollout rule: do not silently fall back to Codex or Claude for OpenCode git flows or failed OpenCode runtime operations.

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

Likely new files:

1. An OpenCode session manager service or layer under `apps/server/src/provider`.
2. An OpenCode git text-generation layer under `apps/server/src/git/Layers`.
3. Focused tests covering both additions.

## Further Considerations

1. If OpenCode does not expose a stable machine-readable streaming contract for approvals, resume, and history management, stop and revise the implementation shape before coding instead of forcing brittle parsing into the provider stack.
2. If OpenCode rollback or history semantics differ materially from Codex and Claude, prefer an explicit capability or error model over fake parity.
3. If OpenCode ships both a long-lived session protocol and a better one-shot structured-output mode, keep those as separate internal layers that share normalization helpers instead of over-coupling git generation to the chat-session harness.