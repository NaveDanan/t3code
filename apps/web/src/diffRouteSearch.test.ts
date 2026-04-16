import { describe, expect, it } from "vitest";

import { parseDiffRouteSearch, updateRightPanelSearch } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      rightPanel: "1",
      rightPanelTab: "diff",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      rightPanel: "1",
      rightPanelTab: "diff",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean panel toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        rightPanel: 1,
        rightPanelTab: "files",
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      rightPanel: "1",
      rightPanelTab: "files",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        rightPanel: true,
        rightPanelTab: "diff",
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      rightPanel: "1",
      rightPanelTab: "diff",
      diffTurnId: "turn-1",
    });
  });

  it("preserves diff selection even when the right panel is closed", () => {
    const parsed = parseDiffRouteSearch({
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      rightPanel: "1",
      rightPanelTab: " ",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      rightPanel: "1",
    });
  });

  it("drops invalid tab values", () => {
    expect(
      parseDiffRouteSearch({
        rightPanel: true,
        rightPanelTab: "terminal",
      }),
    ).toEqual({
      rightPanel: "1",
    });
  });
});

describe("updateRightPanelSearch", () => {
  it("returns the existing search object when opening to the current tab", () => {
    const previous = {
      diffFilePath: "src/app.ts",
      diffTurnId: "turn-1",
      rightPanel: "1",
      rightPanelTab: "files",
    };

    expect(
      updateRightPanelSearch({
        previous,
        open: true,
        tab: "files",
      }),
    ).toBe(previous);
  });

  it("strips right-panel params when closing and preserves other search state", () => {
    expect(
      updateRightPanelSearch({
        previous: {
          diffFilePath: "src/app.ts",
          diffTurnId: "turn-1",
          rightPanel: "1",
          rightPanelTab: "diff",
        },
        open: false,
      }),
    ).toEqual({
      diffFilePath: "src/app.ts",
      diffTurnId: "turn-1",
    });
  });

  it("uses the fallback tab when opening from a closed state", () => {
    expect(
      updateRightPanelSearch({
        previous: {},
        open: true,
        fallbackTab: "diff",
      }),
    ).toEqual({
      rightPanel: "1",
      rightPanelTab: "diff",
    });
  });
});
