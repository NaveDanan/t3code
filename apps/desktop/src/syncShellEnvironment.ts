import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readEnvironmentFromLoginShell,
  resolveLoginShell,
  ShellEnvironmentReader,
} from "@t3tools/shared/shell";

function resolvePathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function splitPathEntries(rawPath: string | undefined, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  return (rawPath ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizePathEntry(entry: string, platform: NodeJS.Platform): string {
  const trimmed = entry.trim().replace(/[\\/]+$/g, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function hasGitOnPath(pathValue: string | undefined, platform: NodeJS.Platform): boolean {
  const executableName = platform === "win32" ? "git.exe" : "git";
  return splitPathEntries(pathValue, platform).some((entry) =>
    existsSync(path.join(entry, executableName)),
  );
}

function resolveWindowsGitDirectory(env: NodeJS.ProcessEnv): string | undefined {
  const localAppData = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
  const programFiles = env.ProgramFiles?.trim() || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"]?.trim() || "C:\\Program Files (x86)";

  const candidates = [
    path.join(localAppData, "Programs", "Git", "cmd"),
    path.join(programFiles, "Git", "cmd"),
    path.join(programFiles, "Git", "bin"),
    path.join(programFilesX86, "Git", "cmd"),
    path.join(programFilesX86, "Git", "bin"),
  ];

  return candidates.find((candidate) => existsSync(path.join(candidate, "git.exe")));
}

function ensureWindowsGitOnPath(env: NodeJS.ProcessEnv): void {
  const pathKey = resolvePathKey(env);
  const currentPath = env[pathKey];
  if (hasGitOnPath(currentPath, "win32")) {
    return;
  }

  const gitDirectory = resolveWindowsGitDirectory(env);
  if (!gitDirectory) {
    return;
  }

  const nextEntries = [gitDirectory, ...splitPathEntries(currentPath, "win32")].filter(
    (entry, index, allEntries) =>
      allEntries.findIndex(
        (candidate) =>
          normalizePathEntry(candidate, "win32") === normalizePathEntry(entry, "win32"),
      ) === index,
  );

  env[pathKey] = nextEntries.join(";");
}

function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (original, varName: string) => {
    return env[varName] ?? original;
  });
}

function readWindowsRegistryPath(registryKey: string): string | undefined {
  try {
    const result = spawnSync("reg.exe", ["query", registryKey, "/v", "Path"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    const match = result.stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Read the current User + Machine PATH from the Windows registry and merge
 * any new entries into `env`. This handles the common case where a tool was
 * installed (adding its directory to PATH) after the Electron app was
 * launched, so the inherited `process.env.PATH` is stale.
 */
function refreshWindowsPathFromRegistry(
  env: NodeJS.ProcessEnv,
  readRegistryPath: RegistryPathReader,
): void {
  const machinePath = readRegistryPath(
    "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment",
  );
  const userPath = readRegistryPath("HKCU\\Environment");

  if (!machinePath && !userPath) return;

  const pathKey = resolvePathKey(env);
  const inheritedEntries = splitPathEntries(env[pathKey], "win32");

  const seen = new Set<string>();
  const merged: string[] = [];

  for (const entry of inheritedEntries) {
    const key = normalizePathEntry(entry, "win32");
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }

  for (const source of [userPath, machinePath]) {
    if (!source) continue;
    const expanded = expandWindowsEnvVars(source, env);
    for (const entry of splitPathEntries(expanded, "win32")) {
      const key = normalizePathEntry(entry, "win32");
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }
  }

  if (merged.length > inheritedEntries.length) {
    env[pathKey] = merged.join(";");
  }
}

export type RegistryPathReader = (registryKey: string) => string | undefined;

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readRegistryPath?: RegistryPathReader;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    refreshWindowsPathFromRegistry(env, options.readRegistryPath ?? readWindowsRegistryPath);
    ensureWindowsGitOnPath(env);
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  try {
    const shell = resolveLoginShell(platform, env.SHELL);
    if (!shell) return;

    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
      "PATH",
      "SSH_AUTH_SOCK",
    ]);

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
