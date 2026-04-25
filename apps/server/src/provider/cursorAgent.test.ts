import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCursorSpawnSpec,
  parseCursorAgentModelsOutput,
  resolveCursorAgentApiModelId,
  resolveCursorAgentModels,
} from "./cursorAgent";

const originalPlatform = process.platform;

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  mockPlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe("buildCursorSpawnSpec", () => {
  it("uses a shell for native Windows execution so Cursor command shims resolve", () => {
    mockPlatform("win32");

    const spec = buildCursorSpawnSpec({
      binaryPath: "cursor-agent",
      cursorArgs: ["--version"],
      executionTarget: { executionBackend: "native" },
    });

    expect(spec.command).toBe("cursor-agent");
    expect(spec.args).toEqual(["--version"]);
    expect(spec.shell).toBe(true);
  });

  it("keeps shell disabled for native non-Windows execution", () => {
    mockPlatform("linux");

    const spec = buildCursorSpawnSpec({
      binaryPath: "cursor-agent",
      cursorArgs: ["--version"],
      executionTarget: { executionBackend: "native" },
    });

    expect(spec.shell).toBe(false);
  });
});

describe("parseCursorAgentModelsOutput", () => {
  it("groups discovered Cursor variants into canonical models with capabilities", () => {
    expect(
      parseCursorAgentModelsOutput(`Available models

auto - Auto
composer-2-fast - Composer 2 Fast (current, default)
composer-2 - Composer 2
gpt-5.4-medium - GPT-5.4 1M
gpt-5.3-codex-high-fast - Codex 5.3 High Fast
gpt-5.3-codex-medium - Codex 5.3 1M

Tip: use --model <id> to switch.`),
    ).toEqual([
      {
        slug: "auto",
        name: "Auto",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "gpt-5.3-codex",
        name: "Codex 5.3",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "high", label: "High" },
            { value: "medium", label: "Medium", isDefault: true },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "composer-2",
        name: "Composer 2",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [{ value: "medium", label: "Medium", isDefault: true }],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
          promptInjectedEffortLevels: [],
        },
      },
    ]);
  });

  it("orders Cursor reasoning effort variants by canonical effort level", () => {
    const models = parseCursorAgentModelsOutput(`Available models

gpt-5.3-codex-high-fast - Codex 5.3 High Fast
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex-medium - Codex 5.3 1M

Tip: use --model <id> to switch.`);

    expect(models[0]?.capabilities?.reasoningEffortLevels).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium", isDefault: true },
      { value: "high", label: "High" },
    ]);
  });
});

describe("resolveCursorAgentModels", () => {
  it("prefers discovered models and still merges custom models", () => {
    expect(
      resolveCursorAgentModels(
        {
          enabled: true,
          binaryPath: "cursor-agent",
          executionBackend: "native",
          customModels: ["my-custom-model"],
          hiddenModels: [],
        },
        parseCursorAgentModelsOutput(`Available models

auto - Auto
composer-2-fast - Composer 2 Fast (current, default)
gpt-5.4-high - GPT-5.4 1M High`),
      ).map((model) => model.slug),
    ).toEqual(["auto", "composer-2", "gpt-5.4", "my-custom-model"]);
  });
});

describe("resolveCursorAgentApiModelId", () => {
  it("maps grouped Cursor model options back to the concrete Cursor CLI slug", () => {
    parseCursorAgentModelsOutput(`Available models

gpt-5.4-medium - GPT-5.4 1M
gpt-5.4-high-fast - GPT-5.4 1M High Fast
claude-opus-4-7-medium - Opus 4.7 1M
claude-opus-4-7-thinking-high - Opus 4.7 1M High Thinking`);

    expect(
      resolveCursorAgentApiModelId({
        model: "gpt-5.4",
        options: { reasoningEffort: "high", fastMode: true, contextWindow: "1m" },
      }),
    ).toBe("gpt-5.4-high-fast");

    expect(
      resolveCursorAgentApiModelId({
        model: "claude-opus-4-7",
        options: { reasoningEffort: "high", thinking: true, contextWindow: "1m" },
      }),
    ).toBe("claude-opus-4-7-thinking-high");
  });
});
