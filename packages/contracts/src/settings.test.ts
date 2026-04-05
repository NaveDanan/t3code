import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "./settings";

describe("default provider settings", () => {
  it("enables OpenCode by default for fresh app startups", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.codex.enabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.claudeAgent.enabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.opencode.enabled).toBe(true);
    expect(DEFAULT_UNIFIED_SETTINGS.providers.opencode.enabled).toBe(true);
  });
});
