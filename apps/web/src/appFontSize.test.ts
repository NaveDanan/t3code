import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_FONT_SIZE } from "@t3tools/contracts/settings";

import { applyAppFontSize, readStoredAppFontSize } from "./appFontSize";
import { CLIENT_SETTINGS_STORAGE_KEY } from "./clientSettings";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (_index: number) => null,
  };
}

describe("appFontSize", () => {
  let storageStub: Storage;
  const dataset: Record<string, string | undefined> = {};

  beforeEach(() => {
    storageStub = createLocalStorageStub();
    vi.stubGlobal("localStorage", storageStub);
    vi.stubGlobal("window", { localStorage: storageStub });
    vi.stubGlobal("document", {
      documentElement: { dataset },
    });
    delete dataset.appFontSize;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the stored app font size when present", () => {
    storageStub.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify({ appFontSize: "xlarge" }));

    expect(readStoredAppFontSize()).toBe("xlarge");
  });

  it("falls back to the default for invalid stored values", () => {
    storageStub.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify({ appFontSize: "huge" }));

    expect(readStoredAppFontSize()).toBe(DEFAULT_APP_FONT_SIZE);
  });

  it("applies the selected app font size to the document root", () => {
    applyAppFontSize("large");

    expect(dataset.appFontSize).toBe("large");
  });
});
