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

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
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
