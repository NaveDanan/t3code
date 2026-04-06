import { spawn, spawnSync, type ChildProcess as NodeChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { ForgeExecutionBackend } from "@t3tools/contracts";
import { ChildProcess } from "effect/unstable/process";

import type { ProcessRunResult } from "../processRunner.ts";
import { runProcess } from "../processRunner.ts";

export const DEFAULT_FORGECODE_BINARY_PATH = "forge";
const LEGACY_FORGECODE_BINARY_PATH = "~/.local/bin/forge";

export interface ForgePorcelainRow extends Record<string, string> {}

export interface ForgeProviderCatalogRow {
  readonly name: string;
  readonly id: string;
  readonly host?: string;
  readonly loggedIn: boolean;
}

export interface ForgeModelCatalogRow {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly providerId: string;
  readonly contextWindow?: string;
  readonly tools?: boolean;
  readonly image?: boolean;
}

export interface ForgeResolvedModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly slug: string;
  readonly providerName: string;
  readonly modelName: string;
}

export interface ForgeExecutionTarget {
  readonly executionBackend: ForgeExecutionBackend;
  readonly wslDistro?: string;
  readonly gitBashPath?: string;
}

export interface ForgeCommandInput {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly allowNonZeroExit?: boolean;
}

export interface ForgeSpawnedProcess {
  readonly process: NodeChildProcess;
  readonly kill: (signal?: NodeJS.Signals) => void;
}

export interface ForgeCliApi {
  readonly run: (input: ForgeCommandInput) => Promise<ProcessRunResult>;
  readonly spawn: (input: ForgeCommandInput) => ForgeSpawnedProcess;
}

export interface ForgeSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly shell: boolean;
}

function normalizeWindowsDriveLetter(value: string): string {
  return value.charAt(0).toLowerCase();
}

export function toWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, "/").trim();
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!driveMatch) {
    return normalized;
  }

  const [, driveLetter, remainder] = driveMatch;
  return `/mnt/${normalizeWindowsDriveLetter(driveLetter!)}/${remainder}`;
}

export function shellQuoteForPosix(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellAssignments(
  env: Readonly<Record<string, string | undefined>> | undefined,
): ReadonlyArray<string> {
  if (!env) {
    return [];
  }

  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${shellQuoteForPosix(value!)}`);
}

export function normalizeForgeBinaryPath(binaryPath: string): string {
  const trimmed = binaryPath.trim();
  if (trimmed.length === 0 || trimmed === LEGACY_FORGECODE_BINARY_PATH) {
    return DEFAULT_FORGECODE_BINARY_PATH;
  }
  return trimmed;
}

export function buildForgeModelSlug(providerId: string, modelId: string): string {
  return `${providerId.trim()}/${modelId.trim()}`;
}

export function splitForgeModelSlug(
  slug: string | null | undefined,
): { readonly providerId: string; readonly modelId: string } | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }

  const providerId = trimmed.slice(0, separatorIndex).trim();
  const modelId = trimmed.slice(separatorIndex + 1).trim();
  if (providerId.length === 0 || modelId.length === 0) {
    return null;
  }

  return { providerId, modelId };
}

export function forgeExecutionBackendLabel(executionBackend: ForgeExecutionBackend): string {
  switch (executionBackend) {
    case "gitbash":
      return "Git Bash";
    case "native":
      return "Native";
    case "wsl":
      return "WSL";
  }
}

export function isForgeExecutionBackendSupportedOnHost(
  executionBackend: ForgeExecutionBackend,
): boolean {
  if (process.platform === "win32") {
    return executionBackend === "wsl" || executionBackend === "gitbash";
  }
  return executionBackend === "native";
}

export function defaultForgeExecutionBackendForHost(): ForgeExecutionBackend {
  return process.platform === "win32" ? "wsl" : "native";
}

export function buildForgeAdapterKey(target: ForgeExecutionTarget): string {
  switch (target.executionBackend) {
    case "gitbash":
      return "forgecode:gitbash";
    case "native":
      return "forgecode:native";
    case "wsl":
      return `forgecode:wsl:${target.wslDistro?.trim() || "default"}`;
  }
}

export function parseForgeAdapterKey(
  adapterKey: string | null | undefined,
): ForgeExecutionTarget | null {
  if (typeof adapterKey !== "string") {
    return null;
  }
  const trimmed = adapterKey.trim();
  if (trimmed === "forgecode:native") {
    return { executionBackend: "native" };
  }
  if (trimmed === "forgecode:gitbash") {
    return { executionBackend: "gitbash" };
  }
  const wslMatch = trimmed.match(/^forgecode:wsl:(.+)$/);
  if (!wslMatch) {
    return null;
  }
  const distro = wslMatch[1]?.trim();
  return {
    executionBackend: "wsl",
    ...(distro && distro !== "default" ? { wslDistro: distro } : {}),
  };
}

export function parseDefaultWslDistro(output: string): string | undefined {
  const normalized = output.replaceAll("\u0000", "").replace(/^\uFEFF/, "");
  const statusMatch = normalized.match(/Default Distribution:\s*(.+)/i);
  const statusDistro = statusMatch?.[1]?.trim();
  if (statusDistro && statusDistro.length > 0) {
    return statusDistro;
  }

  const listMatch = normalized.match(/^\s*\*\s+(.+?)(?:\s{2,}|\s*$)/m);
  const listDistro = listMatch?.[1]?.trim();
  return listDistro && listDistro.length > 0 ? listDistro : undefined;
}

function gitInstallRootFromGitExePath(gitExePath: string): string | undefined {
  const normalized = path.normalize(gitExePath);
  const parentDir = path.dirname(normalized);
  const parentName = path.basename(parentDir).toLowerCase();
  if (parentName !== "cmd" && parentName !== "bin" && parentName !== "mingw64") {
    return undefined;
  }
  return path.dirname(parentDir);
}

function pathEntriesFromEnv(): ReadonlyArray<string> {
  const raw = process.env.Path ?? process.env.PATH ?? "";
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function discoverGitInstallRoots(): ReadonlyArray<string> {
  const candidates = new Set<string>();
  for (const entry of pathEntriesFromEnv()) {
    const gitExePath = path.join(entry, "git.exe");
    if (!existsSync(gitExePath)) {
      continue;
    }
    const root = gitInstallRootFromGitExePath(gitExePath);
    if (root) {
      candidates.add(root);
    }
  }

  const knownRoots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Git") : undefined,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git") : undefined,
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Git")
      : undefined,
  ];
  for (const root of knownRoots) {
    if (root && existsSync(root)) {
      candidates.add(root);
    }
  }

  return [...candidates];
}

export function discoverGitBashPath(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  for (const root of discoverGitInstallRoots()) {
    const bashPath = path.join(root, "bin", "bash.exe");
    if (existsSync(bashPath)) {
      return bashPath;
    }
  }
  return undefined;
}

function normalizeCellBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "[yes]" || normalized === "yes" || normalized === "true") {
    return true;
  }
  if (normalized === "[no]" || normalized === "no" || normalized === "false") {
    return false;
  }
  return undefined;
}

export function parseForgePorcelainTable(output: string): ReadonlyArray<ForgePorcelainRow> {
  const lines = output
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const header = lines[0];
  if (!header) {
    return [];
  }

  const columns = [...header.matchAll(/\S(?:.*?\S)?(?=\s{2,}|$)/g)];
  const starts = columns.map((match) => match.index ?? 0);
  const names = columns.map((match) => match[0].trim());
  if (columns.length === 0) {
    return [];
  }

  return lines.slice(1).map((line) => {
    const row: ForgePorcelainRow = {};
    for (let index = 0; index < names.length; index += 1) {
      const start = starts[index]!;
      const end = starts[index + 1] ?? line.length;
      row[names[index]!.toLowerCase()] = line.slice(start, end).trim();
    }
    return row;
  });
}

export function parseForgeProviderCatalogRows(
  output: string,
): ReadonlyArray<ForgeProviderCatalogRow> {
  return parseForgePorcelainTable(output)
    .map((row) => {
      const name = row.name?.trim();
      const id = row.id?.trim();
      if (!name || !id) {
        return null;
      }

      return Object.assign(
        {
          name,
          id,
          loggedIn: normalizeCellBoolean(row["logged in"]) === true,
        },
        row.host ? { host: row.host } : {},
      ) satisfies ForgeProviderCatalogRow;
    })
    .filter((row): row is ForgeProviderCatalogRow => row !== null);
}

export function parseForgeModelCatalogRows(output: string): ReadonlyArray<ForgeModelCatalogRow> {
  return parseForgePorcelainTable(output)
    .map((row) => {
      const modelId = row.id?.trim();
      const modelName = row.model?.trim();
      const providerName = row.provider?.trim();
      const providerId = row["provider id"]?.trim();
      const tools = normalizeCellBoolean(row.tools);
      const image = normalizeCellBoolean(row.image);
      if (!modelId || !modelName || !providerName || !providerId) {
        return null;
      }

      return Object.assign(
        {
          id: modelId,
          model: modelName,
          provider: providerName,
          providerId,
        },
        row["context window"] ? { contextWindow: row["context window"] } : {},
        tools !== undefined ? { tools } : {},
        image !== undefined ? { image } : {},
      ) satisfies ForgeModelCatalogRow;
    })
    .filter((row): row is ForgeModelCatalogRow => row !== null);
}

export function resolveForgeModel(
  model: string,
  catalog: ReadonlyArray<ForgeModelCatalogRow>,
): ForgeResolvedModel | undefined {
  const direct = splitForgeModelSlug(model);
  if (direct) {
    const match = catalog.find(
      (entry) => entry.providerId === direct.providerId && entry.id === direct.modelId,
    );
    if (!match) {
      return undefined;
    }

    return {
      providerId: match.providerId,
      modelId: match.id,
      slug: buildForgeModelSlug(match.providerId, match.id),
      providerName: match.provider,
      modelName: match.model,
    };
  }

  const trimmed = model.trim();
  const matches = catalog.filter((entry) => entry.id === trimmed);
  if (matches.length !== 1) {
    return undefined;
  }

  const match = matches[0]!;
  return {
    providerId: match.providerId,
    modelId: match.id,
    slug: buildForgeModelSlug(match.providerId, match.id),
    providerName: match.provider,
    modelName: match.model,
  };
}

export function resolveFallbackForgeModel(
  catalog: ReadonlyArray<ForgeModelCatalogRow>,
  preferredProviderId?: string,
): ForgeResolvedModel | undefined {
  const preferred = preferredProviderId?.trim();
  const orderedCatalog =
    preferred && preferred.length > 0
      ? [
          ...catalog.filter((entry) => entry.providerId === preferred),
          ...catalog.filter((entry) => entry.providerId !== preferred),
        ]
      : [...catalog];
  const first = orderedCatalog[0];
  if (!first) {
    return undefined;
  }

  return {
    providerId: first.providerId,
    modelId: first.id,
    slug: buildForgeModelSlug(first.providerId, first.id),
    providerName: first.provider,
    modelName: first.model,
  };
}

function buildForgeCommandLine(input: {
  readonly binaryPath: string;
  readonly forgeArgs: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  const binaryPath = normalizeForgeBinaryPath(input.binaryPath);
  return [
    ...shellAssignments(input.env),
    shellQuoteForPosix(binaryPath),
    ...input.forgeArgs.map(shellQuoteForPosix),
  ].join(" ");
}

export function buildForgeWslShellCommand(input: {
  readonly binaryPath: string;
  readonly forgeArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  const command = buildForgeCommandLine(input);
  return input.cwd ? `cd ${shellQuoteForPosix(toWslPath(input.cwd))} && ${command}` : command;
}

export function buildForgeWslSpawnSpec(input: {
  readonly binaryPath: string;
  readonly forgeArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly wslDistro?: string;
}): ForgeSpawnSpec {
  const baseArgs =
    input.wslDistro && input.wslDistro.trim().length > 0
      ? ["--distribution", input.wslDistro.trim()]
      : [];
  return {
    command: "wsl.exe",
    args: [...baseArgs, "zsh", "-i", "-l", "-c", buildForgeWslShellCommand(input)],
    env: process.env,
    shell: false,
    cwd: undefined,
  };
}

function buildForgeNativeSpawnSpec(input: {
  readonly binaryPath: string;
  readonly forgeArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ForgeSpawnSpec {
  return {
    command: "zsh",
    args: ["-i", "-l", "-c", buildForgeCommandLine(input)],
    env: process.env,
    shell: false,
    cwd: input.cwd,
  };
}

function buildForgeGitBashSpawnSpec(input: {
  readonly binaryPath: string;
  readonly forgeArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly gitBashPath: string;
}): ForgeSpawnSpec {
  const command = `exec zsh -ilc ${shellQuoteForPosix(buildForgeCommandLine(input))}`;
  return {
    command: input.gitBashPath,
    args: ["-lc", command],
    env: process.env,
    shell: false,
    cwd: input.cwd,
  };
}

export function buildForgeSpawnSpec(input: {
  readonly binaryPath: string;
  readonly forgeArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executionTarget: ForgeExecutionTarget;
}): ForgeSpawnSpec {
  switch (input.executionTarget.executionBackend) {
    case "gitbash": {
      const gitBashPath = input.executionTarget.gitBashPath ?? discoverGitBashPath();
      if (!gitBashPath) {
        throw new Error("Git Bash is not available on this machine.");
      }
      return buildForgeGitBashSpawnSpec({
        binaryPath: input.binaryPath,
        forgeArgs: input.forgeArgs,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        gitBashPath,
      });
    }
    case "native":
      return buildForgeNativeSpawnSpec({
        binaryPath: input.binaryPath,
        forgeArgs: input.forgeArgs,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
    case "wsl":
      return buildForgeWslSpawnSpec({
        binaryPath: input.binaryPath,
        forgeArgs: input.forgeArgs,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.executionTarget.wslDistro ? { wslDistro: input.executionTarget.wslDistro } : {}),
      });
  }
}

export function buildForgeCommand(input: {
  readonly binaryPath: string;
  readonly forgeArgs: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executionTarget: ForgeExecutionTarget;
}): ChildProcess.Command {
  const spec = buildForgeSpawnSpec(input);
  return ChildProcess.make(spec.command, [...spec.args], {
    shell: spec.shell,
    env: spec.env,
    cwd: spec.cwd,
  });
}

export function buildForgeBackendTerminalSpawnSpec(input: {
  readonly executionTarget: ForgeExecutionTarget;
  readonly cwd: string;
}): ForgeSpawnSpec {
  switch (input.executionTarget.executionBackend) {
    case "gitbash": {
      const gitBashPath = input.executionTarget.gitBashPath ?? discoverGitBashPath();
      if (!gitBashPath) {
        throw new Error("Git Bash is not available on this machine.");
      }
      return {
        command: gitBashPath,
        args: ["-lc", "exec zsh -il"],
        env: process.env,
        shell: false,
        cwd: input.cwd,
      };
    }
    case "native":
      return {
        command: "zsh",
        args: process.platform === "win32" ? [] : ["-o", "nopromptsp"],
        env: process.env,
        shell: false,
        cwd: input.cwd,
      };
    case "wsl": {
      const baseArgs =
        input.executionTarget.wslDistro && input.executionTarget.wslDistro.trim().length > 0
          ? ["--distribution", input.executionTarget.wslDistro.trim()]
          : [];
      return {
        command: "wsl.exe",
        args: [
          ...baseArgs,
          "sh",
          "-lc",
          `cd ${shellQuoteForPosix(toWslPath(input.cwd))} && exec zsh -il`,
        ],
        env: process.env,
        shell: false,
        cwd: undefined,
      };
    }
  }
}

export function buildForgeBackendShellCommandSpec(input: {
  readonly executionTarget: ForgeExecutionTarget;
  readonly command: string;
  readonly cwd?: string;
}): ForgeSpawnSpec {
  switch (input.executionTarget.executionBackend) {
    case "gitbash": {
      const gitBashPath = input.executionTarget.gitBashPath ?? discoverGitBashPath();
      if (!gitBashPath) {
        throw new Error("Git Bash is not available on this machine.");
      }
      return {
        command: gitBashPath,
        args: ["-lc", `exec zsh -ilc ${shellQuoteForPosix(input.command)}`],
        env: process.env,
        shell: false,
        cwd: input.cwd,
      };
    }
    case "native":
      return {
        command: "zsh",
        args: ["-i", "-l", "-c", input.command],
        env: process.env,
        shell: false,
        cwd: input.cwd,
      };
    case "wsl": {
      const baseArgs =
        input.executionTarget.wslDistro && input.executionTarget.wslDistro.trim().length > 0
          ? ["--distribution", input.executionTarget.wslDistro.trim()]
          : [];
      const command = input.cwd
        ? `cd ${shellQuoteForPosix(toWslPath(input.cwd))} && ${input.command}`
        : input.command;
      return {
        command: "wsl.exe",
        args: [...baseArgs, "zsh", "-i", "-l", "-c", command],
        env: process.env,
        shell: false,
        cwd: undefined,
      };
    }
  }
}

function killNodeChildProcess(child: NodeChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
      });
      return;
    } catch {
      // Fall back to the direct kill attempt below.
    }
  }

  child.kill(signal);
}

export function createForgeCliApi(executionTarget: ForgeExecutionTarget): ForgeCliApi {
  return {
    run: (input) => {
      const spec = buildForgeSpawnSpec({
        binaryPath: input.binaryPath,
        forgeArgs: input.args,
        executionTarget,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      });

      return runProcess(spec.command, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        shell: spec.shell,
        timeoutMs: input.timeoutMs,
        allowNonZeroExit: input.allowNonZeroExit,
      });
    },
    spawn: (input) => {
      const spec = buildForgeSpawnSpec({
        binaryPath: input.binaryPath,
        forgeArgs: input.args,
        executionTarget,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      const child = spawn(spec.command, spec.args, {
        env: spec.env,
        cwd: spec.cwd,
        shell: spec.shell,
        stdio: "pipe",
      });
      child.stdin?.end();

      return {
        process: child,
        kill: (signal) => killNodeChildProcess(child, signal),
      };
    },
  };
}

export async function resolveForgeExecutionTarget(input: {
  readonly executionBackend: ForgeExecutionBackend;
  readonly wslDistro?: string;
}): Promise<ForgeExecutionTarget> {
  switch (input.executionBackend) {
    case "gitbash": {
      const gitBashPath = discoverGitBashPath();
      if (!gitBashPath) {
        throw new Error(
          "Git Bash could not be discovered from the installed Git for Windows paths.",
        );
      }
      const result = await runProcess(gitBashPath, ["-lc", "command -v zsh"], {
        env: process.env,
        shell: false,
        allowNonZeroExit: true,
      });
      if (result.code !== 0 || result.stdout.trim().length === 0) {
        throw new Error("zsh is not installed in Git Bash.");
      }
      return {
        executionBackend: "gitbash",
        gitBashPath,
      };
    }
    case "native": {
      const result = await runProcess("zsh", ["-i", "-l", "-c", "command -v zsh"], {
        env: process.env,
        shell: false,
        allowNonZeroExit: true,
      });
      if (result.code !== 0 || result.stdout.trim().length === 0) {
        throw new Error("zsh is not installed on this machine.");
      }
      return { executionBackend: "native" };
    }
    case "wsl": {
      const wslDistro = input.wslDistro?.trim().length
        ? input.wslDistro.trim()
        : await (async () => {
            const status = await runProcess("wsl.exe", ["--status"], {
              env: process.env,
              shell: false,
              allowNonZeroExit: true,
            });
            if (status.code !== 0) {
              throw new Error(
                detailFromWslStatus(status) ??
                  "WSL is installed but no default distro is configured.",
              );
            }
            let distro = parseDefaultWslDistro(`${status.stdout}\n${status.stderr}`);
            if (!distro) {
              const list = await runProcess("wsl.exe", ["-l", "-v"], {
                env: process.env,
                shell: false,
                allowNonZeroExit: true,
              });
              distro = parseDefaultWslDistro(`${list.stdout}\n${list.stderr}`);
            }
            if (!distro) {
              throw new Error("WSL is installed but no default distro is configured.");
            }
            return distro;
          })();
      const result = await runProcess(
        "wsl.exe",
        ["--distribution", wslDistro, "sh", "-lc", "command -v zsh"],
        {
          env: process.env,
          shell: false,
          allowNonZeroExit: true,
        },
      );
      if (result.code !== 0 || result.stdout.trim().length === 0) {
        throw new Error(`zsh is not installed in the WSL distro '${wslDistro}'.`);
      }
      return {
        executionBackend: "wsl",
        wslDistro,
      };
    }
  }
}

function detailFromWslStatus(result: ProcessRunResult): string | undefined {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }
  return undefined;
}
