import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
} from "./settings";

describe("default provider settings", () => {
  it("enables OpenCode by default for fresh app startups", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.codex.enabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent.enabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.opencode.enabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.forgecode.enabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.forgecode.executionBackend).toBe(
      process.platform === "win32" ? "wsl" : "native",
    );
    expect(DEFAULT_UNIFIED_SETTINGS.providers.opencode.enabled).toBe(true);
    expect(DEFAULT_UNIFIED_SETTINGS.providers.forgecode.enabled).toBe(true);
  });

  it("defaults busy thread follow-ups to queue", () => {
    expect(DEFAULT_UNIFIED_SETTINGS.busyThreadFollowupMode).toBe("queue");
  });

  it("defaults app font size to normal", () => {
    expect(DEFAULT_CLIENT_SETTINGS.appFontSize).toBe("normal");
    expect(DEFAULT_UNIFIED_SETTINGS.appFontSize).toBe("normal");
  });
});
