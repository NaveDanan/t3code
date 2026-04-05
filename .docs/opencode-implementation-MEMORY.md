# OpenCode Implementation Memory

This file is not the main architecture doc anymore.

Read `.plans/18-opencode-harness-implementation.md` for the current implementation shape.

This file exists to preserve the maintenance memory that is easiest to lose:

- the invariants that already caused real bugs
- the decisions that should not be casually reopened
- the file clusters that need to change together
- the regression signals that matter most when touching OpenCode again

## What This File Is For

Use this file when you are:

- changing OpenCode runtime behavior
- changing model resolution or effort variants
- changing resume, recovery, interrupt, or rollback behavior
- debugging a subtle event-ordering bug
- deciding whether a proposed simplification is actually safe

Do not use this file as the primary explanation of how OpenCode works. That now lives in `.plans/18-opencode-harness-implementation.md`.

## Read Order

When working on OpenCode, the useful order is:

1. `.plans/18-opencode-harness-implementation.md`
2. this file
3. `.docs/opencode-desktop-cli-integration.md` if you are reconsidering the runtime boundary or upstream assumptions

## Decisions Already Made

These are current design decisions, not loose suggestions.

### 1. The runtime boundary is a managed local `opencode serve` process

- T3 does not drive the TUI.
- T3 does not parse terminal transcripts.
- T3 uses `@opencode-ai/sdk/v2` against the local OpenCode server.

### 2. Process management stays separate from provider adaptation

- `OpencodeServerManager` owns spawn, health, probe, reuse, restart, and SSE reconnect behavior.
- `OpencodeAdapter` owns translation into T3 provider semantics.
- Do not collapse those responsibilities together without a strong reason.

### 3. Readiness means usable bridge, not installed binary

- `opencode --version` is not a sufficient readiness check.
- A provider is only meaningfully ready when T3 can start the bridge and query real metadata.

### 4. T3 keeps a slug-based OpenCode model selection at the edges

- T3 stores models like `openai/gpt-5`.
- OpenCode requests still use native `{ providerID, modelID }`.
- Translation happens at request time through the live provider catalog.

### 5. Resume state is adapter-owned

- The persisted resume cursor shape is `{ sessionId, cwd }`.
- Treat that cursor as adapter state, not as a UI-level contract.

### 6. Chat and git generation share the same OpenCode foundation

- Chat and one-shot generation must keep using the same server manager and model-resolution logic.
- Do not fork a second OpenCode integration path for git features.

### 7. External-server attach mode is not part of the current product

- There is no attach-to-existing-server setting.
- There is no custom OpenCode server URL.
- If that changes, it is a scope decision and should be documented explicitly.

## Invariants That Already Caused Real Bugs

These are the most important things to not accidentally regress.

### 1. OpenCode user message IDs must be provider-native ascending `msg_...` ids

This is the single most important OpenCode-specific invariant we learned.

Why it matters:

- upstream OpenCode compares message IDs lexicographically in resumed-session reply logic
- UUID-shaped ids or `msg-<uuid>` look valid enough to be misleading
- they can sort incorrectly against older provider-native ids and suppress the next assistant reply

The current rule:

- do not replace `createOpencodeMessageId()` with a UUID or any non-ascending custom scheme
- keep the provider-native `msg_...` shape and ascending ordering behavior

The symptom of breaking this rule is very specific:

- session resumes normally
- `sendTurn.promptAsync.accepted` happens
- then `session.idle` arrives without any assistant output
- second turn appears to do nothing

### 2. OpenCode replays history aggressively; the adapter must filter it aggressively

OpenCode can replay:

- old `message.updated` events
- old assistant messages
- user-authored text parts
- stale idle or busy state

The adapter only works correctly because it keeps enough state to reject replayed events that do not belong to the live turn.

Do not casually remove or weaken:

- `messageInfoById`
- parent-message checks
- active-turn message binding
- current-turn activity gating

### 3. User text-part replay must never become assistant output

OpenCode can emit `message.part.updated` and `message.part.delta` for user messages.

If you stop checking message role carefully, T3 can echo the prompt back as assistant content.

The symptom of breaking this rule is:

- the user prompt appears as streamed assistant text
- turn lifecycle looks corrupted or double-counted

### 4. `session.status busy` is not enough to mean the current turn is really active

OpenCode can emit `busy` after a turn is already effectively complete.

The adapter must only translate `busy` into canonical running state while an active live turn still exists.

The symptom of breaking this rule is:

- the UI stays on `Working...` after the answer already finished

### 5. `session.idle` must not complete a turn until the current turn actually showed activity

OpenCode can replay or emit a stale idle immediately after a new prompt starts.

The adapter must ignore idle until current-turn activity is proven.

Important detail:

- the echoed current user `message.updated` does not count as completion-worthy activity by itself

The symptom of breaking this rule is:

- a fresh turn jumps from running to completed immediately
- often on second-turn or resumed-session flows

### 6. Rollback is best-effort message-boundary revert, not exact turn-native rewind

OpenCode history is message-oriented.

T3 currently implements rollback by repeatedly finding the latest user message and calling `session.revert(messageID)`.

That means:

- rollback is supported
- rollback is useful
- rollback is not exact checkpoint parity with providers that have stronger turn-native rewind semantics

Do not describe or implement it as something stronger than that unless the underlying OpenCode semantics change.

### 7. OpenCode effort UI must stay capability-driven

We already hit one bug where the UI and contracts assumed OpenCode only had `low`, `medium`, and `high`.

Current rule:

- use probed model `variants` when available to build OpenCode reasoning effort capabilities
- do not reintroduce a hardcoded three-value OpenCode reasoning list in the UI path

Current persisted effort union is still finite:

- `none`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

So there is a real distinction between:

- runtime capability discovery
- persisted options typing

If upstream OpenCode starts exposing additional variants that T3 should preserve, the contract layer will need to widen again.

### 8. Custom OpenCode models from settings do not automatically gain capabilities

`providerModelsFromSettings()` appends unknown custom models with:

- `isCustom: true`
- `capabilities: null`

That is intentional and affects UI behavior.

If a custom model is not present in the live OpenCode provider catalog, T3 cannot infer effort controls for it.

## Places Where Changes Must Stay In Sync

These clusters matter more than individual files.

### If you change model resolution

Change and review together:

- `apps/server/src/provider/opencode.ts`
- `apps/server/src/provider/Layers/OpencodeAdapter.ts`
- `apps/server/src/git/Layers/OpencodeTextGeneration.ts`
- relevant adapter and text-generation tests

### If you change provider readiness or model discovery

Change and review together:

- `apps/server/src/provider/Layers/OpencodeServerManager.ts`
- `apps/server/src/provider/Layers/OpencodeProvider.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts`

### If you change effort variants or OpenCode traits UI

Change and review together:

- `packages/contracts/src/model.ts`
- `packages/shared/src/model.ts`
- `packages/shared/src/model.test.ts`
- `apps/server/src/provider/Layers/OpencodeProvider.ts`
- `apps/web/src/composerDraftStore.ts`
- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/components/chat/composerProviderRegistry.tsx`
- `apps/web/src/components/chat/composerProviderRegistry.test.tsx`
- `apps/web/src/components/chat/TraitsPicker.tsx`
- `apps/web/src/components/chat/TraitsPicker.browser.tsx`
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts`

### If you change resume, recovery, or interrupt behavior

Change and review together:

- `apps/server/src/provider/Layers/OpencodeAdapter.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/ProviderService.test.ts`
- any persistence-facing session runtime code touched by the change

### If you change rollback semantics

Change and review together:

- `apps/server/src/provider/Layers/OpencodeAdapter.ts`
- `.plans/18-opencode-harness-implementation.md`
- this file

## Regression Suites Worth Keeping Green

These are the tests most likely to catch real OpenCode regressions.

### Server

- `apps/server/src/provider/Layers/OpencodeServerManager.test.ts`
- `apps/server/src/provider/Layers/OpencodeAdapter.test.ts`
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts`
- `apps/server/src/provider/Layers/ProviderService.test.ts`
- `apps/server/src/git/Layers/OpencodeTextGeneration.test.ts`

### Web and shared

- `apps/web/src/composerDraftStore.test.ts`
- `apps/web/src/components/chat/composerProviderRegistry.test.tsx`
- `apps/web/src/session-logic.test.ts`
- `packages/shared/src/model.test.ts`

Browser-facing coverage also matters, but some `.browser.tsx` files are not collected by a plain package-level Vitest include pattern. Do not treat “No test files found” as real validation for those files.

## Good Debugging Heuristics

These are the fast checks that usually save time.

### If the second resumed turn produces no assistant output

Check message-id generation first.

### If the prompt appears as assistant content

Check role filtering for replayed text parts.

### If the UI gets stuck in running state after the answer is done

Check `session.status busy` handling.

### If a new turn completes almost instantly with no real work

Check stale `session.idle` handling and whether echoed user events are being counted as current-turn activity.

### If OpenCode looks healthy but effort controls are missing or wrong

Check:

- live `configuredProviders`
- model `variants`
- capability mapping in `OpencodeProvider.ts`
- persisted effort typing in `packages/contracts/src/model.ts`

### If chat works but git generation fails

Check model resolution and structured-output decoding first. The git path still depends on the same live provider catalog.

### If an OpenCode thread fails around checkpoint or orchestration behavior

Do not assume the bridge is the problem first. Some historical failures blamed on OpenCode were actually caused by surrounding orchestration assumptions, especially around Git capability checks.

## Known Limits That Are Intentional

These are current product limits, not bugs hidden in one file.

- no external OpenCode server attach mode
- no custom remote server URL
- no upstream-desktop-style Basic Auth wrapper around the local server
- no packaged OpenCode binary strategy inside T3 today
- no promise of exact rollback parity with turn-native providers
- no fully dynamic persisted effort typing for every possible future OpenCode variant

## Open Questions That Are Still Real

These are the main questions that may be revisited later.

1. Should T3 keep the slug abstraction forever, or eventually expose native `{ providerID, modelID }` contracts more directly?
2. Should T3 add attach-to-existing-server mode for advanced users or development workflows?
3. Should persisted OpenCode effort typing become more open-ended if upstream variants keep expanding?
4. Should rollback remain presented as a normal capability, or should the message-boundary limitation become more explicit in UX or capability metadata?

## Update Rule

If you learn a subtle OpenCode invariant, fix a lifecycle regression, or change one of the decisions above:

- update `.plans/18-opencode-harness-implementation.md` if the architecture changed
- update this file if the maintenance memory changed

When docs and code disagree, trust the code and tests first, then update the docs immediately.
