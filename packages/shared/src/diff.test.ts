import { describe, expect, it } from "vitest";

import { extractApplyPatchPaths, parseApplyPatchFiles, parseUnifiedDiffFiles } from "./diff";

describe("extractApplyPatchPaths", () => {
  it("extracts add, update, delete, and move targets in order", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new-file.ts",
      "+export const value = 1;",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/obsolete.ts",
      "*** End Patch",
    ].join("\n");

    expect(extractApplyPatchPaths(patch)).toEqual([
      "src/new-file.ts",
      "src/new-name.ts",
      "src/obsolete.ts",
    ]);
  });

  it("normalizes windows separators and deduplicates repeated paths", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src\\feature.ts",
      "*** Update File: src\\feature.ts",
      "*** End Patch",
    ].join("\n");

    expect(extractApplyPatchPaths(patch)).toEqual(["src/feature.ts"]);
  });
});

describe("parseApplyPatchFiles", () => {
  it("parses file stats and statuses from apply_patch marker text", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new-file.ts",
      "+export const value = 1;",
      "*** Update File: src/old-name.ts",
      "*** Move to: src/new-name.ts",
      "@@",
      "-old",
      "+new",
      "+extra",
      "*** Delete File: src/obsolete.ts",
      "-remove me",
      "*** End Patch",
    ].join("\n");

    expect(parseApplyPatchFiles(patch)).toEqual([
      { path: "src/new-file.ts", additions: 1, deletions: 0, status: "added" },
      {
        path: "src/new-name.ts",
        previousPath: "src/old-name.ts",
        additions: 2,
        deletions: 1,
        status: "moved",
      },
      { path: "src/obsolete.ts", additions: 0, deletions: 1, status: "deleted" },
    ]);
  });

  it("normalizes windows separators and combines repeated paths", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src\\feature.ts",
      "-old",
      "+new",
      "*** Update File: src/feature.ts",
      "+extra",
      "*** End Patch",
    ].join("\n");

    expect(parseApplyPatchFiles(patch)).toEqual([
      { path: "src/feature.ts", additions: 2, deletions: 1, status: "modified" },
    ]);
  });
});

describe("parseUnifiedDiffFiles", () => {
  it("returns empty list for empty diff", () => {
    expect(parseUnifiedDiffFiles("")).toEqual([]);
  });

  it("parses file stats and statuses from unified diffs", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/new-file.ts b/src/new-file.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new-file.ts",
      "@@ -0,0 +1 @@",
      "+export const value = 1;",
      "diff --git a/src/obsolete.ts b/src/obsolete.ts",
      "deleted file mode 100644",
      "--- a/src/obsolete.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(parseUnifiedDiffFiles(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1, status: "modified" },
      { path: "src/new-file.ts", additions: 1, deletions: 0, status: "added" },
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        additions: 0,
        deletions: 0,
        status: "moved",
      },
      { path: "src/obsolete.ts", additions: 0, deletions: 1, status: "deleted" },
    ]);
  });

  it("normalizes CRLF input before parsing", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(parseUnifiedDiffFiles(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1, status: "modified" },
    ]);
  });
});
