# OpenCode Implementation Memory

This file is the durable implementation memory for the OpenCode harness work.

Read this file before continuing any remaining OpenCode phase, test gap, contract decision, or verification task.

This memory is based on the original OpenCode plan, the former standalone TODO list, the current repository code, and the audit performed on 2026-04-05.

## Purpose

- Preserve the implementation knowledge that is easy to lose when the plan and checklist drift behind the code.
- Record the decisions that already proved correct.
- Record the unresolved problems that still need explicit decisions.
- Prevent future work from re-solving problems that were already understood during implementation and audit.

## Current Truth

- OpenCode is no longer a stub in this repository.
- The runtime boundary is a T3-managed `opencode serve` process.
- The server integration uses `@opencode-ai/sdk/v2` instead of an invented subprocess protocol.
- Provider readiness uses real bridge health, provider catalog, and auth metadata instead of a version-only CLI probe.
- The provider adapter supports session start, turn send, interrupt, approval replies, structured user-input replies, read-thread, rollback, stop, and event streaming.
- Git text generation is implemented for commit message, PR content, branch name, and thread title generation.
- Web support is enabled through the existing provider-neutral flow rather than a provider-specific path.
- The original plan's `Current State` section is historical. It describes the old stub-era baseline and must not be treated as the current repository state.

## Thoughts And Lessons

### The documented server and SDK were the right boundary

- The old scaffold implied that T3 needed a custom sidecar or undocumented bridge.
- That assumption was wrong once the documented `opencode serve` and SDK surfaces were validated.
- The practical lesson is to prefer the documented external contract first and only invent transport glue when there is no stable official surface.

### The plan became stale faster than the code

- The original plan still described OpenCode as effectively unimplemented.
- The repository moved ahead of that narrative.
- The practical lesson is to audit code and tests before trusting planning prose as current truth.

### OpenCode fits the provider-neutral stack only after deliberate translation

- OpenCode is session-centric and message-part-centric.
- T3 is turn-centric and expects stable provider session behavior.
- The solution was not to create a second orchestration model, but to translate OpenCode session and message behavior back into the existing canonical abstractions.

## Struggles And Solutions

### 1. SDK or server boundary vs custom subprocess bridge

- Struggle: the old shape implied that T3 needed a custom sidecar or undocumented bridge.
- Why it mattered: inventing a transport would have created unnecessary maintenance risk and protocol drift.
- Solution found: use `@opencode-ai/sdk/v2` and manage `opencode serve` directly.
- Result: the integration aligns with documented OpenCode behavior and avoids a second protocol stack.

### 2. Model contract mismatch

- Struggle: T3 stores OpenCode selections as slugs like `openai/gpt-5`, while OpenCode expects `{ providerID, modelID }`.
- Why it mattered: persisted thread settings, chat turns, and git generation all need a stable selection shape.
- Solution found: keep the slug as the current T3-facing abstraction, then resolve it at runtime against the live OpenCode provider catalog with `resolveOpencodeModel` and `resolveFallbackOpencodeModel`.
- Result: the current implementation works without exposing provider-native model tuples everywhere.
- Remaining issue: contracts still hardcode OpenCode defaults and aliases, so this is only partially solved.

### 3. Session-centric streaming vs turn-centric orchestration

- Struggle: OpenCode emits session, message, and part events rather than T3-native turns.
- Why it mattered: T3 needs stable turn IDs for lifecycle, interruption, recovery, and read-thread behavior.
- Solution found: create provider-native user message IDs (`msg-*`), derive turn IDs as `opencode-turn:${messageId}`, and map assistant `parentID` back to the correct active turn.
- Result: the adapter fits OpenCode into the existing orchestration path without a provider-specific protocol branch.

### 4. Resume and recovery shape

- Struggle: it was unclear whether T3 should persist raw OpenCode session IDs directly or wrap them in adapter-owned state.
- Why it mattered: service restart and stale-session recovery need deterministic rehydration.
- Solution found: persist an adapter-owned opaque resume cursor carrying OpenCode session identity and cwd.
- Result: stale-session recovery for send-turn and rollback already has focused coverage.
- Remaining issue: there is still missing OpenCode-specific restart and rehydration coverage across actual `ProviderService` restart boundaries.

### 5. Readiness must mean usable bridge, not just installed binary

- Struggle: `opencode --version` is not enough to call the provider usable.
- Why it mattered: false-positive readiness would let the UI advertise a provider that T3 cannot actually manage.
- Solution found: readiness is based on manager probe plus health, provider catalog, auth metadata, and model discovery.
- Result: disabled, ready, and missing-install states are covered.
- Remaining issue: non-ENOENT failure coverage and unauthenticated or unknown auth-state coverage still need expansion.

### 6. Git text generation needed to reuse the same OpenCode contract

- Struggle: one-shot git flows could have become a second OpenCode integration path.
- Why it mattered: duplicate logic would drift from chat behavior and double the maintenance surface.
- Solution found: reuse the OpenCode server manager, resolve models against the live catalog, and request structured JSON output through OpenCode's JSON schema support.
- Result: OpenCode git generation is implemented and focused tests already exist.

### 7. Web enablement was broader than one availability flag

- Struggle: the old `available: false` fence in session logic was only one of several OpenCode seams.
- Why it mattered: picker behavior, store sync, effort options, traits, and model normalization all needed to stop assuming only Codex and Claude.
- Solution found: enable OpenCode through the existing generic provider flow and add provider-aware normalization where needed.
- Result: session logic, store sync, composer registry, disabled-provider picker behavior, and traits coverage exist.
- Remaining issue: settings coverage and draft-restoration coverage are still missing.

### 8. Rollback parity is still not a fully closed decision

- Struggle: OpenCode history and revert behavior are message-oriented, not strictly turn-oriented.
- Why it mattered: fake rollback parity would create misleading UX and brittle semantics.
- Solution found so far: implement rollback behavior through the adapter and keep thread snapshots canonical.
- Remaining issue: the repo still needs an explicit decision on whether rollback remains fully exposed or becomes capability-limited when exact turn parity is not guaranteed.

### 9. Verification is partly blocked by environment, not by code

- Struggle: browser UI verification depends on Playwright browsers being installed.
- Why it mattered: missing browsers can look like product regressions when they are really environment gaps.
- Solution found: trust the non-browser web suites and the focused server suites for current signal, and record that browser verification still requires Playwright installation.

## Verified Signals From The Audit

- `bun run lint` passed.
- `bun run fmt:check` passed.
- `bun run --cwd apps/server typecheck` passed.
- `bun run --cwd apps/web typecheck` passed.
- Focused OpenCode server suites passed: 6 files, 109 tests passed, 1 skipped.
- Focused non-browser web suites passed: 3 files, 74 tests passed.
- Browser UI suites were blocked in the audit environment because Playwright browsers were missing.

## Environment And Tooling Notes

- Browser suites need Playwright browsers installed before their results are meaningful.
- The monorepo-root `bun run typecheck` run did not return a clean footer in the shared terminal during the audit, so package-level server and web typechecks were used as the reliable signal.
- On Windows, the OpenCode manager spawns with `shell: true`; the focused server tests pass but emit the child-process deprecation warning.
- The hidden `.docs` folder already exists and is the correct place for OpenCode working memory.

## Files That Matter Most

- `apps/server/src/provider/Layers/OpencodeServerManager.ts`
- `apps/server/src/provider/Layers/OpencodeProvider.ts`
- `apps/server/src/provider/Layers/OpencodeAdapter.ts`
- `apps/server/src/provider/opencode.ts`
- `apps/server/src/git/Layers/OpencodeTextGeneration.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/store.ts`
- `apps/web/src/components/chat/ProviderModelPicker.tsx`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- `packages/contracts/src/model.ts`
- `packages/contracts/src/provider.ts`

## Remaining Hard Problems

1. Decide whether rollback stays fully exposed or becomes explicitly capability-limited.
2. Add OpenCode-specific `ProviderService` restart and rehydration coverage across actual service restart boundaries.
3. Add `OpencodeServerManager` coverage for SSE disconnect and retry, unhealthy-server replacement, and shutdown edge cases.
4. Add provider-probe coverage for non-ENOENT runtime failures and unauthenticated or unknown auth states.
5. Add settings and draft-restoration web coverage.
6. Decide whether the slug abstraction remains stable or should evolve toward explicit `{ providerID, modelID }` contracts.
7. Decide whether optional attach-to-existing OpenCode server support is in scope.

## Recommended Next-Step Order

1. Finish the missing server-side coverage before changing contracts.
2. Make the rollback capability decision explicit before expanding rollback UX assumptions.
3. Add the missing web settings and draft-restoration coverage.
4. Install Playwright browsers and rerun the browser suites.
5. Revisit contract cleanup only after the current abstraction and test surface are stable.

## Update Rule

- If OpenCode behavior changes, tests are added, a transport assumption changes, or the contract decision changes, update this file in the same change.
- If the plan disagrees with the current code and tests, trust the code and tests first, then update the docs.