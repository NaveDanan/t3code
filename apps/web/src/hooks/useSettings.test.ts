import { describe, expect, it } from "vitest";
import { buildLegacyClientSettingsMigrationPatch } from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates archive confirmation from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        appFontSize: "large",
        confirmThreadArchive: true,
        confirmThreadDelete: false,
      }),
    ).toEqual({
      appFontSize: "large",
      confirmThreadArchive: true,
      confirmThreadDelete: false,
    });
  });
});
