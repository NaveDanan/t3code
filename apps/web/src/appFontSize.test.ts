import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_APP_FONT_SIZE } from "@t3tools/contracts/settings";

import { applyAppFontSize, readStoredAppFontSize } from "./appFontSize";
import { CLIENT_SETTINGS_STORAGE_KEY } from "./clientSettings";

describe("appFontSize", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.appFontSize;
  });

  it("reads the stored app font size when present", () => {
    localStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify({ appFontSize: "xlarge" }));

    expect(readStoredAppFontSize()).toBe("xlarge");
  });

  it("falls back to the default for invalid stored values", () => {
    localStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify({ appFontSize: "huge" }));

    expect(readStoredAppFontSize()).toBe(DEFAULT_APP_FONT_SIZE);
  });

  it("applies the selected app font size to the document root", () => {
    applyAppFontSize("large");

    expect(document.documentElement.dataset.appFontSize).toBe("large");
  });
});
