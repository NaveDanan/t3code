import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";

import { Cache, Duration, Effect, Exit, Layer, Option, Path } from "effect";

import type {
  ProjectEntry,
  ProjectSearchTextFileResult,
  ProjectSearchTextMatch,
  ProjectSearchTextResult,
} from "@t3tools/contracts";

import { GitCore } from "../../git/Services/GitCore.ts";
import { runProcess } from "../../processRunner.ts";
import {
  WorkspaceEntries,
  WorkspaceEntriesError,
  type WorkspaceEntriesShape,
} from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 3;
const CONTENT_SEARCH_MAX_FILE_BYTES = 1024 * 1024;
const CONTENT_SEARCH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: SearchableWorkspaceEntry[];
  truncated: boolean;
}

interface SearchableWorkspaceEntry extends ProjectEntry {
  normalizedPath: string;
  normalizedName: string;
}

interface RankedWorkspaceEntry {
  entry: SearchableWorkspaceEntry;
  score: number;
}

interface RgJsonMatchRecord {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    matches?: Array<{
      start: number;
      end: number;
      line_before?: string;
      match: string;
      line_after?: string;
    }>;
  };
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function toSearchableWorkspaceEntry(entry: ProjectEntry): SearchableWorkspaceEntry {
  const normalizedPath = entry.path.toLowerCase();
  return {
    ...entry,
    normalizedPath,
    normalizedName: basenameOf(normalizedPath),
  };
}

function normalizeQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function scoreEntry(entry: SearchableWorkspaceEntry, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedPath.includes(query)) return 6;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, query);
  if (pathFuzzyScore !== null) {
    return 200 + pathFuzzyScore;
  }

  return null;
}

function compareRankedWorkspaceEntries(
  left: RankedWorkspaceEntry,
  right: RankedWorkspaceEntry,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.entry.path.localeCompare(right.entry.path);
}

function findInsertionIndex(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) {
      break;
    }

    if (compareRankedWorkspaceEntries(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

function insertRankedEntry(
  rankedEntries: RankedWorkspaceEntry[],
  candidate: RankedWorkspaceEntry,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];

  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

function buildIgnoredGlobArgs(): string[] {
  return [...IGNORED_DIRECTORY_NAMES].flatMap((directoryName) => ["--glob", `!${directoryName}`]);
}

function createEmptyTextSearchResult(): ProjectSearchTextResult {
  return {
    files: [],
    truncated: false,
  };
}

function trimLineText(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function projectTextSearchResultFromMap(
  filesByPath: Map<string, ProjectSearchTextMatch[]>,
  truncated: boolean,
): ProjectSearchTextResult {
  return {
    files: [...filesByPath.entries()].map(
      ([path, matches]): ProjectSearchTextFileResult => ({
        path,
        matches,
      }),
    ),
    truncated,
  };
}

function collectTextSearchMatchesFromRipgrep(
  stdout: string,
  limit: number,
  truncated: boolean,
): ProjectSearchTextResult {
  const filesByPath = new Map<string, ProjectSearchTextMatch[]>();
  let nextTruncated = truncated;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let record: RgJsonMatchRecord;
    try {
      record = JSON.parse(line) as RgJsonMatchRecord;
    } catch {
      continue;
    }

    if (record.type !== "match") {
      continue;
    }

    const pathValue = record.data?.path?.text ? toPosixPath(record.data.path.text) : null;
    const lineNumber = record.data?.line_number;
    const lineText = record.data?.lines?.text;
    const matches = record.data?.matches;
    if (!pathValue || typeof lineNumber !== "number" || typeof lineText !== "string") {
      continue;
    }

    const submatches = matches?.map((m) => ({
      start: m.start,
      end: m.end,
    }));

    if (!filesByPath.has(pathValue)) {
      if (filesByPath.size >= limit) {
        nextTruncated = true;
        continue;
      }
      filesByPath.set(pathValue, []);
    }

    const fileMatches = filesByPath.get(pathValue);
    if (!fileMatches || fileMatches.length >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE) {
      continue;
    }

    fileMatches.push({
      lineNumber,
      lineText: trimLineText(lineText),
      submatches: submatches && submatches.length > 0 ? submatches : undefined,
    });
  }

  return projectTextSearchResultFromMap(filesByPath, nextTruncated);
}

export const makeWorkspaceEntries = Effect.gen(function* () {
  const path = yield* Path.Path;
  const gitOption = yield* Effect.serviceOption(GitCore);
  const workspacePaths = yield* WorkspacePaths;

  const isInsideGitWorkTree = (cwd: string): Effect.Effect<boolean> =>
    Option.match(gitOption, {
      onSome: (git) => git.isInsideWorkTree(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
      onNone: () => Effect.succeed(false),
    });

  const filterGitIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    Option.match(gitOption, {
      onSome: (git) =>
        git.filterIgnoredPaths(cwd, relativePaths).pipe(
          Effect.map((paths) => [...paths]),
          Effect.catch(() => Effect.succeed(relativePaths)),
        ),
      onNone: () => Effect.succeed(relativePaths),
    });

  const buildWorkspaceIndexFromGit = Effect.fn("WorkspaceEntries.buildWorkspaceIndexFromGit")(
    function* (cwd: string) {
      if (Option.isNone(gitOption)) {
        return null;
      }
      if (!(yield* isInsideGitWorkTree(cwd))) {
        return null;
      }

      const listedFiles = yield* gitOption.value
        .listWorkspaceFiles(cwd)
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (!listedFiles) {
        return null;
      }

      const listedPaths = [...listedFiles.paths]
        .map((entry) => toPosixPath(entry))
        .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
      const filePaths = yield* filterGitIgnoredPaths(cwd, listedPaths);

      const directorySet = new Set<string>();
      for (const filePath of filePaths) {
        for (const directoryPath of directoryAncestorsOf(filePath)) {
          if (!isPathInIgnoredDirectory(directoryPath)) {
            directorySet.add(directoryPath);
          }
        }
      }

      const directoryEntries = [...directorySet]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (directoryPath): ProjectEntry => ({
            path: directoryPath,
            kind: "directory",
            parentPath: parentPathOf(directoryPath),
          }),
        )
        .map(toSearchableWorkspaceEntry);
      const fileEntries = [...new Set(filePaths)]
        .toSorted((left, right) => left.localeCompare(right))
        .map(
          (filePath): ProjectEntry => ({
            path: filePath,
            kind: "file",
            parentPath: parentPathOf(filePath),
          }),
        )
        .map(toSearchableWorkspaceEntry);

      const entries = [...directoryEntries, ...fileEntries];
      return {
        scannedAt: Date.now(),
        entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
        truncated: listedFiles.truncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
      };
    },
  );

  const readDirectoryEntries = Effect.fn("WorkspaceEntries.readDirectoryEntries")(function* (
    cwd: string,
    relativeDir: string,
  ): Effect.fn.Return<
    { readonly relativeDir: string; readonly dirents: Dirent[] | null },
    WorkspaceEntriesError
  > {
    return yield* Effect.tryPromise({
      try: async () => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        const dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
        return { relativeDir, dirents };
      },
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.readDirectoryEntries",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        () => relativeDir.length > 0,
        () => Effect.succeed({ relativeDir, dirents: null }),
      ),
    );
  });

  const buildWorkspaceIndexFromFilesystem = Effect.fn(
    "WorkspaceEntries.buildWorkspaceIndexFromFilesystem",
  )(function* (cwd: string): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const shouldFilterWithGitIgnore = yield* isInsideGitWorkTree(cwd);

    let pendingDirectories: string[] = [""];
    const entries: SearchableWorkspaceEntry[] = [];
    let truncated = false;

    while (pendingDirectories.length > 0 && !truncated) {
      const currentDirectories = pendingDirectories;
      pendingDirectories = [];

      const directoryEntries = yield* Effect.forEach(
        currentDirectories,
        (relativeDir) => readDirectoryEntries(cwd, relativeDir),
        { concurrency: WORKSPACE_SCAN_READDIR_CONCURRENCY },
      );

      const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
        const { relativeDir, dirents } = directoryEntry;
        if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

        dirents.sort((left, right) => left.name.localeCompare(right.name));
        const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
        for (const dirent of dirents) {
          if (!dirent.name || dirent.name === "." || dirent.name === "..") {
            continue;
          }
          if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
            continue;
          }
          if (!dirent.isDirectory() && !dirent.isFile()) {
            continue;
          }

          const relativePath = toPosixPath(
            relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
          );
          if (isPathInIgnoredDirectory(relativePath)) {
            continue;
          }
          candidates.push({ dirent, relativePath });
        }
        return candidates;
      });

      const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
        candidateEntries.map((entry) => entry.relativePath),
      );
      const allowedPathSet = shouldFilterWithGitIgnore
        ? new Set(yield* filterGitIgnoredPaths(cwd, candidatePaths))
        : null;

      for (const candidateEntries of candidateEntriesByDirectory) {
        for (const candidate of candidateEntries) {
          if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
            continue;
          }

          const entry = toSearchableWorkspaceEntry({
            path: candidate.relativePath,
            kind: candidate.dirent.isDirectory() ? "directory" : "file",
            parentPath: parentPathOf(candidate.relativePath),
          });
          entries.push(entry);

          if (candidate.dirent.isDirectory()) {
            pendingDirectories.push(candidate.relativePath);
          }

          if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
            truncated = true;
            break;
          }
        }

        if (truncated) {
          break;
        }
      }
    }

    return {
      scannedAt: Date.now(),
      entries,
      truncated,
    };
  });

  const buildWorkspaceIndex = Effect.fn("WorkspaceEntries.buildWorkspaceIndex")(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspaceIndex, WorkspaceEntriesError> {
    const gitIndexed = yield* buildWorkspaceIndexFromGit(cwd);
    if (gitIndexed) {
      return gitIndexed;
    }
    return yield* buildWorkspaceIndexFromFilesystem(cwd);
  });

  const workspaceIndexCache = yield* Cache.makeWith<string, WorkspaceIndex, WorkspaceEntriesError>(
    buildWorkspaceIndex,
    {
      capacity: WORKSPACE_CACHE_MAX_KEYS,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? Duration.millis(WORKSPACE_CACHE_TTL_MS) : Duration.zero,
    },
  );

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceEntriesError({
            cwd,
            operation: "workspaceEntries.normalizeWorkspaceRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
  });

  const invalidate: WorkspaceEntriesShape["invalidate"] = Effect.fn("WorkspaceEntries.invalidate")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.catch(() => Effect.succeed(cwd)),
      );
      yield* Cache.invalidate(workspaceIndexCache, cwd);
      if (normalizedCwd !== cwd) {
        yield* Cache.invalidate(workspaceIndexCache, normalizedCwd);
      }
    },
  );

  const search: WorkspaceEntriesShape["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      return yield* Cache.get(workspaceIndexCache, normalizedCwd).pipe(
        Effect.map((index) => {
          const normalizedQuery = normalizeQuery(input.query);
          const limit = Math.max(0, Math.floor(input.limit));
          const rankedEntries: RankedWorkspaceEntry[] = [];
          let matchedEntryCount = 0;

          for (const entry of index.entries) {
            const score = scoreEntry(entry, normalizedQuery);
            if (score === null) {
              continue;
            }

            matchedEntryCount += 1;
            insertRankedEntry(rankedEntries, { entry, score }, limit);
          }

          return {
            entries: rankedEntries.map((candidate) => candidate.entry),
            truncated: index.truncated || matchedEntryCount > limit,
          };
        }),
      );
    },
  );

  const searchTextWithRipgrep = Effect.fn("WorkspaceEntries.searchTextWithRipgrep")(function* (
    cwd: string,
    query: string,
    limit: number,
  ): Effect.fn.Return<ProjectSearchTextResult, WorkspaceEntriesError> {
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess(
          "rg",
          [
            "--json",
            "--line-number",
            "--smart-case",
            "--fixed-strings",
            "--hidden",
            "--max-count",
            String(CONTENT_SEARCH_MAX_MATCHES_PER_FILE),
            ...buildIgnoredGlobArgs(),
            query,
            ".",
          ],
          {
            cwd,
            allowNonZeroExit: true,
            maxBufferBytes: CONTENT_SEARCH_MAX_BUFFER_BYTES,
            outputMode: "truncate",
          },
        ),
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd,
          operation: "workspaceEntries.searchText.ripgrep",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

    if ((result.code ?? 0) > 1) {
      return yield* new WorkspaceEntriesError({
        cwd,
        operation: "workspaceEntries.searchText.ripgrep",
        detail:
          result.stderr.trim().length > 0
            ? result.stderr.trim()
            : `ripgrep exited with code ${result.code ?? "null"}`,
      });
    }

    if (result.code === 1) {
      return createEmptyTextSearchResult();
    }

    return collectTextSearchMatchesFromRipgrep(
      result.stdout,
      limit,
      Boolean(result.stdoutTruncated || result.stderrTruncated),
    );
  });

  const searchTextByScanningIndex = Effect.fn("WorkspaceEntries.searchTextByScanningIndex")(
    function* (
      cwd: string,
      index: WorkspaceIndex,
      query: string,
      limit: number,
    ): Effect.fn.Return<ProjectSearchTextResult, WorkspaceEntriesError> {
      if (query.length === 0) {
        return createEmptyTextSearchResult();
      }

      const filesByPath = new Map<string, ProjectSearchTextMatch[]>();
      let truncated = index.truncated;
      const normalizedQuery = query.toLowerCase();

      for (const entry of index.entries) {
        if (entry.kind !== "file") {
          continue;
        }

        const matches = yield* Effect.tryPromise({
          try: async () => {
            const absolutePath = path.join(cwd, entry.path);
            const stat = await fsPromises.stat(absolutePath);
            if (stat.size > CONTENT_SEARCH_MAX_FILE_BYTES) {
              return [] as ProjectSearchTextMatch[];
            }

            const contents = await fsPromises.readFile(absolutePath, "utf8");
            if (contents.includes("\u0000")) {
              return [] as ProjectSearchTextMatch[];
            }

            const collectedMatches: ProjectSearchTextMatch[] = [];
            const lines = contents.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index];
              if (!line || !line.toLowerCase().includes(normalizedQuery)) {
                continue;
              }
              const lowerLine = line.toLowerCase();
              const queryStart = lowerLine.indexOf(normalizedQuery);
              collectedMatches.push({
                lineNumber: index + 1,
                lineText: line,
                submatches: [{ start: queryStart, end: queryStart + query.length }],
              });
              if (collectedMatches.length >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE) {
                break;
              }
            }

            return collectedMatches;
          },
          catch: (cause) =>
            new WorkspaceEntriesError({
              cwd,
              operation: "workspaceEntries.searchText.scan",
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(Effect.catch(() => Effect.succeed([] as ProjectSearchTextMatch[])));

        if (matches.length === 0) {
          continue;
        }

        if (filesByPath.size >= limit) {
          truncated = true;
          continue;
        }

        filesByPath.set(entry.path, matches);
      }

      return projectTextSearchResultFromMap(filesByPath, truncated);
    },
  );

  const searchText: WorkspaceEntriesShape["searchText"] = Effect.fn("WorkspaceEntries.searchText")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const query = input.query.trim();
      const limit = Math.max(0, Math.floor(input.limit));
      if (query.length === 0 || limit === 0) {
        return createEmptyTextSearchResult();
      }

      const index = yield* Cache.get(workspaceIndexCache, normalizedCwd);
      return yield* searchTextWithRipgrep(normalizedCwd, query, limit).pipe(
        Effect.catch(() => searchTextByScanningIndex(normalizedCwd, index, query, limit)),
      );
    },
  );

  return {
    invalidate,
    search,
    searchText,
  } satisfies WorkspaceEntriesShape;
});

export const WorkspaceEntriesLive = Layer.effect(WorkspaceEntries, makeWorkspaceEntries);
