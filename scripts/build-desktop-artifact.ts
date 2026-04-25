#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter as PATH_DELIMITER, join } from "node:path";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  Data,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  Schema,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const ProductionMacIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacIconPng),
);
const ProductionLinuxIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionLinuxIconPng),
);
const ProductionWindowsIconPngSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconPng),
);
const ProductionWindowsIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<string>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isPlatformError = (cause: unknown): cause is PlatformError.PlatformError =>
  Predicate.isTagged(cause, "PlatformError");

export const ensureDirectory = Effect.fn("ensureDirectory")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;

  const existingType = yield* fs.stat(directory).pipe(
    Effect.map((stat) => stat.type),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
    ),
  );

  if (existingType === "Directory") {
    return;
  }

  if (existingType !== null) {
    return yield* new BuildScriptError({
      message: `Build output path exists but is not a directory: ${directory}`,
    });
  }

  yield* fs.makeDirectory(directory, { recursive: true }).pipe(
    Effect.catch((cause) =>
      isPlatformError(cause) && cause.reason._tag === "AlreadyExists"
        ? fs.stat(directory).pipe(
            Effect.flatMap((stat) =>
              stat.type === "Directory"
                ? Effect.void
                : Effect.fail(
                    new BuildScriptError({
                      message: `Build output path exists but is not a directory: ${directory}`,
                    }),
                  ),
            ),
          )
        : Effect.fail(cause),
    ),
  );
});

// Resolve the on-disk directory of a package in the workspace using bun's
// module resolution. node-pty is a server dependency, so we resolve from
// apps/server where it is declared.
function resolveWorkspacePackageDir(packageName: string, repoRoot: string): string | undefined {
  const serverDir = join(repoRoot, "apps/server");
  const result = spawnSync(
    "bun",
    [
      "-e",
      `process.stdout.write(require('path').dirname(require.resolve(${JSON.stringify(`${packageName}/package.json`)})))`,
    ],
    { cwd: serverDir, encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  return result.stdout.trim();
}

// node-pty ships no Linux prebuilds — it must be compiled with node-gyp.
// This function ensures the compiled binary exists in the workspace before
// staging so the stage install can skip re-compiling with --ignore-scripts.
const ensureNodePtyBuilt = Effect.fn("ensureNodePtyBuilt")(function* (repoRoot: string) {
  const nodePtyDir = resolveWorkspacePackageDir("node-pty", repoRoot);
  if (!nodePtyDir) {
    return yield* new BuildScriptError({ message: "Could not resolve node-pty in workspace." });
  }

  const nativeAddon = join(nodePtyDir, "build", "Release", "pty.node");
  if (existsSync(nativeAddon)) {
    return nodePtyDir;
  }

  // Check build tools before attempting compilation.
  const makeCheck = spawnSync("which", ["make"], { encoding: "utf8" });
  if (makeCheck.status !== 0) {
    return yield* new BuildScriptError({
      message:
        "node-pty has no Linux prebuilds and must be compiled from source.\n" +
        "Install build tools first:\n" +
        "  sudo apt install build-essential",
    });
  }

  yield* Effect.log("[desktop-artifact] Compiling node-pty native module...");
  yield* runCommand(
    ChildProcess.make({
      cwd: nodePtyDir,
      stderr: "inherit",
      stdout: "inherit",
    })`bunx node-gyp rebuild`,
  );

  if (!existsSync(nativeAddon)) {
    return yield* new BuildScriptError({
      message: `node-pty compiled but expected binary not found at ${nativeAddon}`,
    });
  }

  return nodePtyDir;
});

function resolveGitCommitHash(repoRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
}

function resolvePythonForNodeGyp(): string | undefined {
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && existsSync(configured)) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = join(localAppData, "Programs", "Python", version, "python.exe");
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = spawnSync("python", ["-c", "import sys;print(sys.executable)"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !existsSync(executable)) {
    return undefined;
  }

  return executable;
}

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: string | undefined;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3CodeBaseVersion: string;
  readonly t3codeCommitHash: string;
  readonly packageManager: string;
  readonly private: true;
  readonly description: string;
  readonly homepage: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.string("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.boolean("T3CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.string("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const releaseDir = resolveBooleanFlag(input.mockUpdates, env.mockUpdates)
    ? "release-mock"
    : "release";
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, releaseDir),
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const mockUpdateServerPort = mergeOptions(
    input.mockUpdateServerPort,
    env.mockUpdateServerPort,
    undefined,
  );

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild,
    keepStage,
    signed,
    verbose,
    mockUpdates,
    mockUpdateServerPort,
  } satisfies ResolvedBuildOptions;
});

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const REQUIRED_WINDOWS_ICON_SIZE = 256;

export function listIcoImageSizes(buffer: Uint8Array): number[] {
  if (buffer.byteLength < 6) {
    return [];
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    return [];
  }

  const imageCount = view.getUint16(4, true);
  const sizes: number[] = [];
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16;
    if (entryOffset + 16 > buffer.byteLength) {
      break;
    }

    const widthByte = view.getUint8(entryOffset);
    const heightByte = view.getUint8(entryOffset + 1);
    const width = widthByte === 0 ? 256 : widthByte;
    const height = heightByte === 0 ? 256 : heightByte;
    if (width === height) {
      sizes.push(width);
    }
  }

  return sizes;
}

function hasIcoImageSize(buffer: Uint8Array, expectedSize: number): boolean {
  return listIcoImageSizes(buffer).includes(expectedSize);
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function generateWindowsIcoFromPng(sourcePng: string, targetIco: string, verbose: boolean): void {
  if (process.platform !== "win32") {
    throw new Error("Windows ICO generation is only available on Windows hosts.");
  }

  const tempPngPath = `${targetIco}.256.png`;
  const powerShellScript = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    `$sourcePath = ${toPowerShellLiteral(sourcePng)}`,
    `$targetPath = ${toPowerShellLiteral(targetIco)}`,
    `$tempPngPath = ${toPowerShellLiteral(tempPngPath)}`,
    "$image = [System.Drawing.Image]::FromFile($sourcePath)",
    "try {",
    "  $bitmap = New-Object System.Drawing.Bitmap 256, 256",
    "  try {",
    "    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "    try {",
    "      $graphics.Clear([System.Drawing.Color]::Transparent)",
    "      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
    "      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality",
    "      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
    "      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality",
    "      $graphics.DrawImage($image, 0, 0, 256, 256)",
    "    } finally {",
    "      $graphics.Dispose()",
    "    }",
    "    $bitmap.Save($tempPngPath, [System.Drawing.Imaging.ImageFormat]::Png)",
    "  } finally {",
    "    $bitmap.Dispose()",
    "  }",
    "} finally {",
    "  $image.Dispose()",
    "}",
    "$pngBytes = [System.IO.File]::ReadAllBytes($tempPngPath)",
    "$stream = [System.IO.File]::Open($targetPath, [System.IO.FileMode]::Create)",
    "$writer = New-Object System.IO.BinaryWriter($stream)",
    "try {",
    "  $writer.Write([UInt16]0)",
    "  $writer.Write([UInt16]1)",
    "  $writer.Write([UInt16]1)",
    "  $writer.Write([Byte]0)",
    "  $writer.Write([Byte]0)",
    "  $writer.Write([Byte]0)",
    "  $writer.Write([Byte]0)",
    "  $writer.Write([UInt16]1)",
    "  $writer.Write([UInt16]32)",
    "  $writer.Write([UInt32]$pngBytes.Length)",
    "  $writer.Write([UInt32]22)",
    "  $writer.Write($pngBytes)",
    "} finally {",
    "  $writer.Dispose()",
    "  $stream.Dispose()",
    "}",
    "Remove-Item $tempPngPath -ErrorAction SilentlyContinue",
  ].join("\n");

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(powerShellScript)],
    {
      stdio: verbose ? "inherit" : "pipe",
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    const stderr = `${result.stderr ?? ""}`.trim();
    throw new Error(stderr.length > 0 ? stderr : "PowerShell failed to generate icon.ico.");
  }
}

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionMacIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${iconSource} --out ${iconPngPath}`,
    );

    yield* generateMacIconSet(iconSource, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionLinuxIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function stageWindowsIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSourceIco = yield* ProductionWindowsIconSource;
    if (!(yield* fs.exists(iconSourceIco))) {
      return yield* new BuildScriptError({
        message: `Production Windows icon source is missing at ${iconSourceIco}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    const iconBytes = readFileSync(iconSourceIco);
    if (hasIcoImageSize(iconBytes, REQUIRED_WINDOWS_ICON_SIZE)) {
      yield* fs.copyFile(iconSourceIco, iconPath);
      return;
    }

    const iconSourcePng = yield* ProductionWindowsIconPngSource;
    if (!(yield* fs.exists(iconSourcePng))) {
      return yield* new BuildScriptError({
        message: `Production Windows icon fallback source is missing at ${iconSourcePng}`,
      });
    }

    yield* Effect.logWarning(
      `[desktop-artifact] Production Windows icon is missing a ${REQUIRED_WINDOWS_ICON_SIZE}x${REQUIRED_WINDOWS_ICON_SIZE} entry. Regenerating icon.ico from ${iconSourcePng}.`,
    );
    yield* Effect.try({
      try: () => generateWindowsIcoFromPng(iconSourcePng, iconPath, verbose),
      catch: (cause) =>
        new BuildScriptError({
          message: `Failed to generate a valid Windows icon from ${iconSourcePng}.`,
          cause,
        }),
    });

    if (!hasIcoImageSize(readFileSync(iconPath), REQUIRED_WINDOWS_ICON_SIZE)) {
      return yield* new BuildScriptError({
        message: `Generated Windows icon at ${iconPath} is still missing a ${REQUIRED_WINDOWS_ICON_SIZE}x${REQUIRED_WINDOWS_ICON_SIZE} entry.`,
      });
    }
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, unknown> | undefined,
  catalog: Record<string, unknown>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      (entry): entry is [string, string] => entry[0] !== "electron" && typeof entry[1] === "string",
    ),
  );
  const resolvedCatalog = Object.fromEntries(
    Object.entries(catalog).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, resolvedCatalog, "apps/desktop");
}

function resolveGitHubPublishConfig():
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly releaseType: "release";
    }
  | undefined {
  const rawRepo =
    process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    "";
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: "release",
  };
}

const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  productName: string,
  signed: boolean,
  mockUpdates: boolean,
  mockUpdateServerPort: string | undefined,
) {
  const buildConfig: Record<string, unknown> = {
    appId: "com.t3tools.t3code",
    productName,
    artifactName: "NJ-Code-${version}-${arch}.${ext}",
    npmRebuild: false,
    nodeGypRebuild: false,
    asarUnpack: ["node_modules/@github/copilot-*/**/*"],
    directories: {
      buildResources: "apps/desktop/resources",
    },
  };
  const publishConfig = resolveGitHubPublishConfig();
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  } else if (mockUpdates) {
    buildConfig.publish = [
      {
        provider: "generic",
        url: `http://localhost:${mockUpdateServerPort ?? 3000}`,
      },
    ];
  }

  if (platform === "mac") {
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
    };
  }

  if (platform === "linux") {
    buildConfig.linux = {
      target: [target],
      executableName: "t3code",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: productName,
        },
      },
    };
    // deb/rpm package managers run afterInstall as root — use it to fix the
    // chrome-sandbox SUID permissions required by Electron's process sandbox.
    const afterInstallScript = "apps/desktop/resources/linux-after-install.sh";
    const afterRemoveScript = "apps/desktop/resources/linux-after-remove.sh";
    buildConfig.deb = { afterInstall: afterInstallScript, afterRemove: afterRemoveScript };
    buildConfig.rpm = { afterInstall: afterInstallScript, afterRemove: afterRemoveScript };
  }

  if (platform === "win") {
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir, verbose);
  }
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedServerDependencies = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        serverDependencies,
        rootPackageJson.workspaces.catalog,
        "apps/server",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () =>
      resolveDesktopRuntimeDependencies(
        desktopPackageJson.dependencies,
        rootPackageJson.workspaces.catalog,
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const appVersion = options.version ?? rootPackageJson.version;
  const t3CodeBaseVersion = rootPackageJson.t3CodeBaseVersion;
  const commitHash = resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      })`bun run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));

  yield* assertPlatformBuildResources(options.platform, stageResourcesDir, options.verbose);

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  yield* fs.copy(stageResourcesDir, path.join(stageAppDir, "apps/desktop/prod-resources"));

  const stagePackageJson: StagePackageJson = {
    name: "t3code",
    version: appVersion,
    buildVersion: appVersion,
    t3CodeBaseVersion,
    t3codeCommitHash: commitHash,
    packageManager: rootPackageJson.packageManager,
    private: true,
    description: "NJ Code desktop build",
    homepage: "https://github.com/pingdotgg/t3code",
    author: { name: "T3 Tools", email: "hi@t3.chat" },
    main: "apps/desktop/dist-electron/main.js",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      desktopPackageJson.productName ?? "NJ Code",
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
    ),
    dependencies: {
      ...resolvedServerDependencies,
      ...resolvedDesktopRuntimeDependencies,
    },
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");

  // On Linux, node-pty has no prebuilds and would require 'make' during install.
  // Instead we compile it once in the workspace, skip scripts during staging,
  // then transplant the compiled binary into the stage.
  const shouldBuildNativeModules = options.platform === "linux";
  const workspaceNodePtyDir = shouldBuildNativeModules
    ? yield* ensureNodePtyBuilt(repoRoot)
    : undefined;

  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      ...commandOutputOptions(options.verbose),
      // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
      shell: process.platform === "win32",
    })`bun install --production ${shouldBuildNativeModules ? "--ignore-scripts" : ""}`,
  );

  if (workspaceNodePtyDir !== undefined) {
    yield* Effect.log("[desktop-artifact] Transplanting compiled node-pty into stage...");
    const stagePtyBuildDir = path.join(stageAppDir, "node_modules/node-pty/build");
    const workspacePtyBuildDir = path.join(workspaceNodePtyDir, "build");
    yield* fs.copy(workspacePtyBuildDir, stagePtyBuildDir, { overwrite: true });
  }

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (process.platform === "win32") {
    const python = resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }

  const workspaceBinDir = join(repoRoot, "node_modules", ".bin");
  buildEnv.PATH = buildEnv.PATH
    ? `${workspaceBinDir}${PATH_DELIMITER}${buildEnv.PATH}`
    : workspaceBinDir;
  const electronBuilderCli = join(repoRoot, "node_modules", "electron-builder", "cli.js");

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: buildEnv,
      ...commandOutputOptions(options.verbose),
      // Invoke the local electron-builder CLI with Node directly, so a shell is unnecessary.
      shell: false,
    })`${process.execPath} ${electronBuilderCli} ${platformConfig.cliFlag} --${options.arch} --publish never`,
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* ensureDirectory(options.outputDir);

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: T3CODE_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.string("mock-update-server-port").pipe(
    Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for NJ Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
  NodeRuntime.runMain,
);
