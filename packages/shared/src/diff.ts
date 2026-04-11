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
