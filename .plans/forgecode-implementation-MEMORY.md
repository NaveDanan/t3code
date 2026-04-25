# ForgeCode Harness Implementation Memory

This document records the implementation facts for the ForgeCode harness in NJ Code.

It is not a speculative plan. It is the current reference for how the integration is supposed to work, which upstream constraints matter, and which shortcuts are intentionally rejected.

## Current Truth

- ForgeCode is integrated as a real provider: `forgecode`.
- The harness is WSL-only on Windows in v1.
- T3 does not automate the Forge TUI and does not parse terminal transcripts.
- T3 runs one-shot `forge` subprocesses and reconstructs canonical T3 turns from exported Forge conversation dumps.
- T3 stores Forge resume state as `{ conversationId, cwd }`.
- Default T3 execution maps to Forge agent `forge`.
- T3 Plan Mode maps to Forge agent `muse`.
- T3 explicitly rejects interactive `approval-required` mode, structured request responses, structured user-input responses, and rollback for Forge.

## Mental Model

The integration is CLI-adapter based, not server based:

```text
NJ server
  -> ForgeAdapter
  -> launches `forge` inside WSL per turn
  -> sets provider/model with per-process env overrides
  -> exports the conversation after the turn
  -> parses Forge dump JSON
  -> projects minimal canonical ProviderRuntimeEvent items
  -> existing orchestration, persistence, and web flows
```

That distinction matters. Forge is not treated like Codex app-server and not treated like OpenCode's managed `serve` bridge. The stable boundary here is the Forge CLI plus conversation dumps.

## Upstream Facts That Matter

- The installed CLI is WSL-local on this machine, not native Windows.
- Forge conversation IDs must be UUIDs.
- `forge --prompt ... --conversation-id <uuid> --agent <forge|muse> --directory <cwd>` is the usable turn entrypoint.
- Provider and model selection can be isolated per subprocess with:
  - `FORGE_SESSION__PROVIDER_ID`
  - `FORGE_SESSION__MODEL_ID`
- Forge model identity is really `providerId + modelId`.
- Bare model IDs are not globally unique across Forge upstream providers.
- `forge conversation dump <id>` writes a JSON dump file, not structured stdout.
- No reliable base-path override was found for Forge's underlying `~/forge` state.

These facts are why T3 persists canonical Forge model slugs as `providerId/modelId`, resolves legacy bare model IDs only when unique, and isolates only temp dump artifacts rather than Forge's full internal storage.

## Non-Obvious Constraints

- Windows support means WSL only. Git Bash is out of scope for v1.
- T3 must not mutate the user's global Forge provider/model settings just to run a request.
- Temp dump files must be written outside the repo and cleaned up after use.
- The Forge CLI still shares the user's normal `~/forge` database and snapshots.
- `approval-required` cannot be emulated honestly because the Forge CLI does not expose a T3-compatible interactive approval handshake.
- Rollback also cannot be faked honestly from the currently exposed Forge primitives.

## Model Identity Rules

- Canonical Forge slugs are `providerId/modelId`.
- Live model lists from `forge list model --porcelain` should surface canonical slugs.
- Hidden/custom model handling in T3 should preserve canonical slugs.
- Legacy bare model strings are tolerated only for compatibility and only when they match exactly one live model row.
- If a bare model ID is ambiguous across providers, validation must fail and the user must re-pick a provider-qualified model.

## Session And Resume Rules

- New Forge sessions generate a UUID v4 locally.
- Resume state stores only:
  - `conversationId`
  - `cwd`
- On restart, T3 validates the stored conversation by dumping it before trusting the resumed session.
- `readThread` rebuilds snapshots from the dump, not from terminal output.

## Event Projection Rules

Forge event projection stays intentionally minimal:

- `turn.started`
- assistant text
- proposed-plan blocks in plan mode
- tool lifecycle items when recoverable from the dump
- token usage when present
- `turn.completed`
- `turn.aborted`
- runtime errors

T3 should not pretend to stream Forge token-by-token by scraping terminal text.

## Git Text Generation Rules

- Forge git text generation reuses the CLI-backed harness, not `forge data`.
- Generation is one-shot and schema-driven.
- T3 asks Forge for strict JSON output.
- T3 validates the JSON locally against schema.
- T3 retries once when Forge returns invalid structured output.
- The temporary Forge conversation used for git generation is deleted afterward.

## Things That Already Bit Us

- Forge dumps can accidentally land in the repo root if the dump path is not controlled.
- Using bare Forge model IDs is unsafe because multiple upstream providers can expose the same `ID`.
- The docs and the live CLI do not always line up exactly; the installed CLI behavior wins.
- Exact optional typing in this repo is strict enough that parser helpers need to omit optional fields cleanly, not assign `undefined`.

## What To Preserve

- Keep Forge subprocesses isolated with per-process env overrides.
- Keep dump cleanup outside the repo.
- Keep the adapter honest about unsupported features.
- Keep model slugs provider-qualified at the T3 boundary.
- Keep recovery based on persisted `{ conversationId, cwd }`.
