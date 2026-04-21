import { parsePatchFiles } from "@pierre/diffs";

export interface ParsedUnifiedDiffFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status: "added" | "deleted" | "modified" | "moved";
}

const APPLY_PATCH_PATH_REGEX = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s+(.+?)\s*$/;
const APPLY_PATCH_MOVE_REGEX = /^\*\*\*\s+Move to:\s+(.+?)\s*$/;

interface MutableApplyPatchFile {
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
  status: ParsedUnifiedDiffFile["status"];
  order: number;
}

function normalizeDiffPath(pathValue: string | undefined): string | null {
  if (typeof pathValue !== "string") {
    return null;
  }
  const normalized = pathValue.trim().replaceAll("\\", "/");
  if (normalized.length === 0 || normalized === "/dev/null") {
    return null;
  }
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    return normalized.slice(2);
  }
  return normalized;
}

function normalizeApplyPatchPath(pathValue: string): string | null {
  const normalized = pathValue.trim().replaceAll("\\", "/");
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.startsWith("***") || normalized.startsWith("@@")) {
    return null;
  }
  return normalized;
}

export function parseApplyPatchFiles(text: string): ReadonlyArray<ParsedUnifiedDiffFile> {
  const files: MutableApplyPatchFile[] = [];
  let currentFileIndex = -1;

  const startFile = (action: string, pathValue: string) => {
    const path = normalizeApplyPatchPath(pathValue);
    if (!path) {
      currentFileIndex = -1;
      return;
    }
    const status =
      action === "Add" ? "added" : action === "Delete" ? "deleted" : ("modified" as const);
    currentFileIndex = files.length;
    files.push({
      path,
      additions: 0,
      deletions: 0,
      status,
      order: currentFileIndex,
    });
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fileMatch = APPLY_PATCH_PATH_REGEX.exec(line);
    if (fileMatch) {
      startFile(fileMatch[1] ?? "", fileMatch[2] ?? "");
      continue;
    }

    const moveMatch = APPLY_PATCH_MOVE_REGEX.exec(line);
    const currentFile = currentFileIndex >= 0 ? files[currentFileIndex] : undefined;
    if (moveMatch && currentFile) {
      const path = normalizeApplyPatchPath(moveMatch[1] ?? "");
      if (path) {
        currentFile.previousPath = currentFile.path;
        currentFile.path = path;
        currentFile.status = "moved";
      }
      continue;
    }

    if (!currentFile) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentFile.additions += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      currentFile.deletions += 1;
    }
  }

  return files
    .toSorted((left, right) => left.order - right.order)
    .map(({ order: _order, ...file }) => file);
}

export function parseUnifiedDiffFiles(diff: string): ReadonlyArray<ParsedUnifiedDiffFile> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  return parsedPatches
    .flatMap((patch) =>
      patch.files.flatMap((file) => {
        const path = normalizeDiffPath(file.name);
        if (!path) {
          return [];
        }
        const previousPath = normalizeDiffPath(file.prevName);
        return [
          {
            path,
            ...(previousPath && previousPath !== path ? { previousPath } : {}),
            additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
            deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
            status:
              file.type === "new"
                ? "added"
                : file.type === "deleted"
                  ? "deleted"
                  : file.type === "rename-pure" || file.type === "rename-changed"
                    ? "moved"
                    : "modified",
          } satisfies ParsedUnifiedDiffFile,
        ];
      }),
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export function extractApplyPatchPaths(text: string): ReadonlyArray<string> {
  const paths: string[] = [];
  const pathIndexes = new Map<string, number>();

  const upsertPath = (pathValue: string) => {
    const existingIndex = pathIndexes.get(pathValue);
    if (existingIndex !== undefined) {
      return existingIndex;
    }
    const nextIndex = paths.length;
    paths.push(pathValue);
    pathIndexes.set(pathValue, nextIndex);
    return nextIndex;
  };

  const replaceLastPath = (pathValue: string) => {
    const existingIndex = pathIndexes.get(pathValue);
    const lastIndex = paths.length - 1;
    if (lastIndex < 0) {
      upsertPath(pathValue);
      return;
    }

    const previousPath = paths[lastIndex];
    if (previousPath === pathValue) {
      return;
    }

    if (existingIndex !== undefined) {
      paths.splice(lastIndex, 1);
      pathIndexes.clear();
      for (let index = 0; index < paths.length; index += 1) {
        pathIndexes.set(paths[index]!, index);
      }
      return;
    }

    paths[lastIndex] = pathValue;
    pathIndexes.delete(previousPath!);
    pathIndexes.set(pathValue, lastIndex);
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fileMatch = APPLY_PATCH_PATH_REGEX.exec(line);
    if (fileMatch) {
      const pathValue = normalizeApplyPatchPath(fileMatch[2] ?? "");
      if (pathValue) {
        upsertPath(pathValue);
      }
      continue;
    }

    const moveMatch = APPLY_PATCH_MOVE_REGEX.exec(line);
    if (moveMatch) {
      const pathValue = normalizeApplyPatchPath(moveMatch[1] ?? "");
      if (pathValue) {
        replaceLastPath(pathValue);
      }
    }
  }

  return paths;
}

function applyPatchStatus(action: string): ParsedUnifiedDiffFile["status"] {
  if (action === "Add") {
    return "added";
  }
  if (action === "Delete") {
    return "deleted";
  }
  return "modified";
}

function mergeApplyPatchStatus(
  current: ParsedUnifiedDiffFile["status"],
  next: ParsedUnifiedDiffFile["status"],
): ParsedUnifiedDiffFile["status"] {
  if (current === next) {
    return current;
  }
  if (current === "moved" || next === "moved") {
    return "moved";
  }
  if (current === "added" || next === "added") {
    return "added";
  }
  if (current === "deleted" || next === "deleted") {
    return "deleted";
  }
  return "modified";
}

function normalizeApplyPatchFiles(
  files: ReadonlyArray<MutableApplyPatchFile>,
): ReadonlyArray<ParsedUnifiedDiffFile> {
  const byPath = new Map<string, MutableApplyPatchFile>();

  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, { ...file });
      continue;
    }

    existing.additions += file.additions;
    existing.deletions += file.deletions;
    existing.status = mergeApplyPatchStatus(existing.status, file.status);
    existing.order = Math.min(existing.order, file.order);
    if (!existing.previousPath && file.previousPath) {
      existing.previousPath = file.previousPath;
    }
  }

  return [...byPath.values()]
    .toSorted((left, right) => left.order - right.order || left.path.localeCompare(right.path))
    .map(({ order: _order, ...file }) => file);
}

export function parseApplyPatchFiles(text: string): ReadonlyArray<ParsedUnifiedDiffFile> {
  const files: MutableApplyPatchFile[] = [];
  let current: MutableApplyPatchFile | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }
    files.push(current);
    current = null;
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fileMatch = APPLY_PATCH_PATH_REGEX.exec(line);
    if (fileMatch) {
      commitCurrent();
      const path = normalizeApplyPatchPath(fileMatch[2] ?? "");
      if (!path) {
        continue;
      }
      current = {
        path,
        additions: 0,
        deletions: 0,
        status: applyPatchStatus(fileMatch[1] ?? ""),
        order: files.length,
      };
      continue;
    }

    const moveMatch = APPLY_PATCH_MOVE_REGEX.exec(line);
    if (moveMatch && current) {
      const path = normalizeApplyPatchPath(moveMatch[1] ?? "");
      if (path && path !== current.path) {
        current.previousPath = current.path;
        current.path = path;
      }
      current.status = "moved";
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }

  commitCurrent();
  return normalizeApplyPatchFiles(files);
}
