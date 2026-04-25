# Cursor CLI Provider Integration Plan

## Summary
Add Cursor CLI as a first-class provider using provider id `cursorAgent` and display name `Cursor`.

The integration will use documented Cursor headless mode via `cursor-agent -p --output-format stream-json`, with queued follow-ups handled by NJ Code’s existing orchestration queue. It will support long-lived NJ Code conversations, multiple threads, provider/session recovery, model selection, settings, and internal text-generation surfaces. Native mid-turn steering will not be exposed because Cursor’s documented headless CLI does not provide a stable interactive steering channel.

## Public APIs And Contracts
- Extend provider contracts with `cursorAgent` across provider kind unions, display names, model selection schemas, provider settings, server settings patches, provider snapshots, runtime capabilities, and defaults.
- Add `CursorAgentSettings` with:
  - `enabled`
  - `binaryPath`, defaulting to `cursor-agent`
  - `executionBackend`, defaulting to WSL on Windows and native elsewhere
  - `customModels`
  - `hiddenModels`
- Add Cursor model handling:
  - built-in model `auto`, which omits `--model`
  - custom model strings, passed through as `--model <value>`
  - no provider-specific reasoning/effort options unless Cursor exposes a documented stable flag later
- Generalize server execution backend typing so Cursor can use `native | wsl`, while Forge keeps its existing backend behavior.

## Server Implementation
- Extract Forge’s reusable CLI execution pieces into a shared server utility:
  - native/WSL backend resolution
  - WSL path conversion
  - POSIX shell quoting
  - process spawn/run helpers
  - backend availability probing
- Keep Forge-specific catalog/model logic in Forge modules, and update Forge to use the shared execution utility without behavior changes.
- Add a Cursor provider status service:
  - disabled state follows settings
  - installed probe runs `cursor-agent --version` on the selected backend
  - unavailable state clearly reports missing binary, missing WSL, or probe failure
  - auth state is “unknown until first run” unless Cursor emits a clear auth error
  - provider snapshot exposes `auto` plus custom models
- Add `CursorAdapter`:
  - process-per-turn execution with `cursor-agent -p --output-format stream-json`
  - `--resume <session_id>` when Cursor returns a prior session id
  - `--model` only when selected model is not `auto`
  - queue-only follow-ups through existing orchestration behavior
  - reject image attachments initially unless implementation verifies a documented Cursor attachment mechanism
  - reject approval-required interactive requests because documented headless Cursor does not expose approval callbacks
  - kill the running process tree on interrupt
  - emit canonical provider runtime events for assistant text, tool calls, warnings, failures, interruptions, and turn completion
- Implement best-effort Cursor thread recovery:
  - persist Cursor session id/resume cursor per NJ Code thread
  - retain local turn snapshots for `readThread`
  - on rollback, trim local snapshots and clear Cursor’s resume id because Cursor does not document provider-side context rollback
  - after rollback, start the next Cursor run as a fresh Cursor session with a bounded transcript prelude from retained NJ Code turns
- Register Cursor in:
  - provider registry
  - adapter registry
  - provider service recovery/resume cursor handling
  - orchestration model-change restart rules
  - text-generation routing
- Add Cursor internal text generation:
  - use `cursor-agent -p --output-format json` or final `stream-json` result
  - require strict JSON output from prompts
  - validate decoded output with existing schemas
  - fail clearly on malformed JSON instead of silently accepting prose

## Web/UI Implementation
- Add Cursor to provider settings, provider cards, model picker, model-selection construction, custom/hidden model settings, and text-generation provider choices.
- Add a Cursor backend selector similar to Forge:
  - `WSL` recommended on Windows
  - `Native` available where installed
  - backend changes apply to new Cursor sessions
- Keep UI behavior aligned with existing provider surfaces:
  - multiple threads
  - queued prompts while busy
  - provider status/error display
  - custom model entry
  - hidden model filtering
  - runtime-mode controls with unsupported approval-required behavior surfaced predictably

## Test Plan
- Add contract tests for provider kind, model selection, settings schema, settings patch schema, defaults, and provider snapshots.
- Add shared model tests for Cursor defaults, custom model resolution, aliases, and provider option normalization.
- Add server tests for:
  - provider status when disabled, missing binary, missing WSL, and installed
  - registry and adapter registration
  - session startup, resume id persistence, turn streaming, queued follow-up behavior, interrupt, stop, and rollback
  - malformed Cursor stream lines, nonzero exit, missing result event, stderr warnings, and auth-like failures
- Add text-generation tests for valid JSON, malformed JSON, `auto` model omitting `--model`, and custom models passing `--model`.
- Add web tests for settings rendering, provider list inclusion, backend selection, model picker behavior, custom models, hidden models, and Cursor model-selection creation.
- During implementation, run targeted `bun run test ...` suites, then required final validation:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`

## Assumptions
- Cursor execution mode is headless queue-only, per selected default.
- Windows support defaults to WSL, with native allowed when the binary is available.
- Cursor is available in chat and all internal text-generation surfaces.
- Official Cursor CLI references used for this plan:
  - https://docs.cursor.com/en/cli/using
  - https://docs.cursor.com/en/cli/installation
