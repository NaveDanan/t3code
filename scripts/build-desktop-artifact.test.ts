import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Option, Path } from "effect";

import {
  ensureDirectory,
  listIcoImageSizes,
  resolveBuildOptions,
} from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );

  it.effect("allows an existing artifact output directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-desktop-artifact-test-",
        });
        const outputDir = path.join(tempRoot, "release");

        yield* fs.makeDirectory(outputDir);
        yield* ensureDirectory(outputDir);

        const stat = yield* fs.stat(outputDir);
        assert.equal(stat.type, "Directory");
      }),
    ),
  );

  it("parses ICO directory sizes including 256x256 entries", () => {
    const iconDirectory = Uint8Array.from([
      0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    assert.deepStrictEqual(listIcoImageSizes(iconDirectory), [16, 256]);
  });

  it("returns an empty size list for invalid ICO headers", () => {
    assert.deepStrictEqual(listIcoImageSizes(Uint8Array.from([0x01, 0x02, 0x03])), []);
  });
});
