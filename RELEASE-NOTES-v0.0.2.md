# NJ Code v0.0.2 — Alpha

> Split-pane workflows, Cursor provider support, benchmarks infrastructure, and a refreshed brand identity.

**Apr 24 – 26, 2026** · 122 files changed · **+8,177** / **-295** lines

---

## 🏁 New: Benchmarks — Race Your Agents Head-to-Head

Benchmarks is a brand-new subsystem that lets you **pit multiple AI providers against each other on the exact same coding task**, side by side, in real time.

### How it works

1. **Pick a project and branch** — Choose any project across your environments and select a Git branch as your starting point.
2. **Write one prompt** — Author a single prompt that every provider will receive.
3. **Configure 2–6 lanes** — Each lane is a distinct provider + model pair (e.g., *Codex / GPT-5.4* vs *Claude Agent / Claude Sonnet 4.6*). Add up to 6 lanes to compare.
4. **Hit Run** — NJ Code creates a **fresh Git worktree per lane** to guarantee full isolation, then dispatches the prompt to every provider **simultaneously**.
5. **Watch the results** — Each lane renders as an embedded chat view in a grid. See how each agent approaches the same problem, compare code quality, speed, and tool usage in real time.

### Key details

- **Isolated execution** — Each lane runs on its own temporary worktree branch, so providers can't interfere with each other's file changes.
- **Full chat views** — Lane results aren't summaries — they're complete, live ChatView instances in a compact benchmarkLane presentation mode. You can follow every step the agent takes.
- **Run history** — Up to 30 past runs are persisted to local storage and browsable via the settings page. Jump back to any previous benchmark at any time.
- **Smart validation** — The runner checks that all providers are online, models are valid, no duplicate providers across lanes, and the prompt isn't empty before launching.
- **Open in full** — Each lane card has an "Open full chat" link to expand the conversation in the main chat view.

Navigate to **Settings → Benchmarks** to get started.

---

## 🪟 New: Split-Pane Chat View — Two Threads, One Workspace

Work on two agent conversations simultaneously without switching tabs. Split Chat View brings true side-by-side multitasking to NJ Code.

### How it works

1. **Drag any thread** from the sidebar toward the left or right edge of the workspace.
2. **Drop it** — a dashed overlay appears showing exactly where the new pane will open.
3. **Two full chat views** appear side by side, each with its own thread, conversation history, and composer.
4. **Click a pane** to select it — the selected pane drives the URL route and gets the active composer.

### Key details

- **Drag-to-split** — Drop zones light up along the left/right edges (opens a new pane on that side) or in the center (replaces the selected pane's thread). Uses the custom `application/x-t3-thread-ref` MIME protocol.
- **Shared terminal** — Instead of duplicating terminal drawers, a single ThreadTerminalHost sits below both panes and automatically switches to the terminal of whichever pane you select.
- **Persistent state** — Your split layout, pane assignments, and selection survive page reloads via local storage. Stale references to deleted threads are automatically cleaned up on load.
- **Close anytime** — Each pane has an × button. Closing a pane collapses back to single-pane mode and navigates to the remaining thread.
- **Minimum width enforcement** — Panes require at least 360px each. If the viewport is too narrow (<720px), splitting is prevented to avoid unusable layouts.
- **Presentation modes** — ChatView now supports three modes: `route` (normal), `splitPane`, and `benchmarkLane`. Non-selected split panes have their composer disabled and chrome stripped, keeping the focus on the active thread.

---

## 🔌 Cursor Agent & Provider Integration

Complete integration of **Cursor** as a first-class provider. NJ Code can now broker sessions through Cursor's agent infrastructure alongside Codex.

- **CursorAdapter** — Full adapter layer translating NJ Code's orchestration protocol to Cursor's native API (839 lines)
- **CursorProvider** — Provider lifecycle management: session startup, resume, and teardown (454 lines)
- **cursorAgent** — Agent handling turn execution, streaming, and tool-call dispatch (649 lines)
- **CursorTextGeneration** — Git-layer text generation routing for Cursor-backed sessions
- **Provider registry** — ProviderAdapterRegistry and ProviderRegistry updated with Cursor service bindings; ProviderService handles multi-provider dispatch
- **GitHub Copilot** — 160+ lines of improvements to the existing provider
- Full test suite with **181+ assertions**

---

## 🔧 Other Improvements

- **Composer provider registry** — New composerProviderRegistry for provider selection in the chat composer
- **Model selection** — Expanded utilities in modelSelection.ts and modelSelectionUtils.ts
- **TraitsPicker** — Improved component with new browser-level tests
- **Contracts** — New model and settings schemas in packages/contracts
- **Build scripts** — Desktop artifact build expanded by 228+ lines with improved test coverage
- **Dev runner** — Updated with 51 new lines and 97 additional test lines
- **CI** — Release workflow gains new steps
- **Version** — Bumped to v0.0.2 across all packages

---


<sub>NJ Code · Alpha · v0.0.2 · Built by Nave Danan · Forked from T3-Code · v0.0.17</sub>
