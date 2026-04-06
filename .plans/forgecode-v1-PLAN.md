# ForgeCode Harness Integration Plan

## Summary
- Add ForgeCode as a WSL-only provider backed by the installed `forge` CLI, mirroring OpenCode’s product surface where Forge exposes stable primitives: provider status, chat sessions, restart recovery, web model/provider settings, and git text generation.
- Implement Forge as a CLI adapter, not a managed server. T3 will run `forge` subprocesses inside WSL, persist a Forge conversation UUID plus cwd as resume state, and rebuild canonical T3 turns from exported conversation JSON after each turn.
- Default T3 execution maps to Forge agent `forge`; T3 Plan Mode maps to Forge agent `muse`.
- Supervised / `approval-required` mode is rejected for Forge with an explicit unsupported-mode error. Rollback is also rejected explicitly; T3 must not fake either feature.
- Add [forgecode-implementation-MEMORY.md](d:/Projects/t3code/.plans/forgecode-implementation-MEMORY.md) as the long-lived implementation reference, following the same style as [18-opencode-harness-implementation.md](d:/Projects/t3code/.plans/18-opencode-harness-implementation.md).

## Public Interfaces / Contract Changes
- Canonical Forge model identity becomes `forgeProviderId/modelId`, not a bare model ID, because the installed CLI exposes both `PROVIDER ID` and `ID` and model IDs are not globally unique.
- Compatibility resolution still accepts legacy bare Forge model strings when they uniquely match the live catalog; if ambiguous, T3 fails validation and requires a fresh model pick.
- Keep `ForgeCodeModelOptions` empty for v1 unless implementation discovers a real user-facing option worth persisting. Provider disambiguation lives in the canonical combined model slug, not extra options.
- `providers.forgecode.binaryPath` remains the WSL-side binary path (default `~/.local/bin/forge`); Windows support for Forge is explicitly WSL-only in v1.

## Implementation Changes
- Finish wiring Forge into provider snapshot registry, adapter registry, provider services, session recovery, and git text-generation routing. Treat the existing local Forge scaffolding as reusable draft code, not as finished behavior.
- Keep the existing WSL command helpers. Probe with `forge --version`, `forge provider list --porcelain`, `forge list model --porcelain`, and `forge list agent --porcelain`. Parse models as `providerId/modelId` slugs and surface provider/auth state from the live Forge catalog.
- Implement a real `ForgeAdapter` that owns active subprocesses, session state, interrupt handling, and event publication.
- Generate UUID v4 conversation IDs locally for new sessions and persist `{ conversationId, cwd }` as the resume cursor.
- Run turns via WSL `forge --prompt ... --conversation-id <uuid> --agent <forge|muse> --directory <cwd>`.
- Set provider/model per subprocess with `FORGE_SESSION__PROVIDER_ID` and `FORGE_SESSION__MODEL_ID` instead of mutating user global config.
- After each turn, export the conversation to a managed temp dump directory outside the repo, parse the JSON dump, and project the latest changes back into canonical T3 turn items and runtime events.
- Keep event projection buffered/minimal: turn start, assistant output, proposed plan blocks, tool/work log items when recoverable from dump content, usage when present, and completion/failure/interrupt. Do not attempt pseudo-streaming from terminal transcripts.
- Make `readThread` rebuild full thread snapshots from dump JSON.
- Make `interruptTurn` and `stopSession` terminate the active WSL child process and mark the active turn/session correctly.
- Make `respondToRequest`, `respondToUserInput`, and `rollbackThread` fail clearly for Forge with provider-specific unsupported errors.
- Reject `approval-required` at session start or sendTurn with a Forge-specific validation error explaining that the CLI does not expose T3-compatible interactive approval requests.
- Add a Forge text-generation layer and route it from the existing dispatcher.
- Reuse the CLI-backed harness for git text generation instead of `forge data` in v1, so behavior stays aligned with the main adapter and optional attachment-aware title generation remains possible.
- Use one-shot Forge subprocesses with per-process env overrides, strict JSON instructions in the prompt, T3-side schema validation, and a single invalid-JSON retry path.
- Add Forge to provider pickers, composer draft persistence, settings panels, model selectors, provider icons/labels, and provider-specific composer registry. Make hidden/custom model controls use canonical combined slugs.
- Write [forgecode-implementation-MEMORY.md](d:/Projects/t3code/.plans/forgecode-implementation-MEMORY.md) as the implementation reference, capturing the non-obvious constraints: WSL-only execution, UUID session IDs, dump-file behavior, global `~/forge` state sharing, per-process env overrides, docs/CLI mismatches, rejected supervised mode, rejected rollback, and temp-dump cleanup.

## Test Plan
- Registry tests confirm Forge is registered in both snapshot and adapter registries.
- Forge provider tests cover WSL command construction, porcelain parsing, auth-state derivation, combined model slug generation, and fallback behavior.
- Adapter tests cover start/resume, `forge` vs `muse` agent selection, per-process env overrides, dump parsing into turns/proposed plans/usage, interrupt/stop behavior, and explicit failure paths for supervised mode, request responses, user-input responses, and rollback.
- ProviderService recovery tests confirm Forge sessions recover after restart using persisted cwd and model selection.
- Git text-generation tests cover commit messages, PR content, branch names, and thread titles.
- Web tests cover Forge visibility in provider pickers, settings, draft persistence, and model selection.
- Implementation is not complete until `bun fmt`, `bun lint`, and `bun typecheck` all pass.

## Assumptions
- Windows support for Forge in this repo means WSL-only in v1; Git Bash is out of scope.
- “Full parity” means all major T3 integration surfaces are supported, but T3 will not emulate Forge features that the CLI does not expose safely or truthfully.
- Forge conversation state shares the user’s existing `~/forge` database/snapshots because no base-path override was found in the current upstream/source; T3 isolates only temp dump artifacts, not Forge’s underlying storage.
- Existing local Forge draft files in this worktree are treated as scaffolding to refine or replace as needed.
