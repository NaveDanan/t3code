import { describe, expect, it } from "vitest";

import { buildProjectEntriesTree } from "./projectEntriesTree";

describe("buildProjectEntriesTree", () => {
  it("builds nested trees from file entries and inferred parent directories", () => {
    const tree = buildProjectEntriesTree([
      { path: "apps/web/src/main.tsx", kind: "file" },
      { path: "README.md", kind: "file" },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/web/src",
        path: "apps/web/src",
        children: [
          {
            kind: "file",
            name: "main.tsx",
            path: "apps/web/src/main.tsx",
          },
        ],
      },
      {
        kind: "file",
        name: "README.md",
        path: "README.md",
      },
    ]);
  });

  it("preserves explicitly indexed directories even when they have no files", () => {
    const tree = buildProjectEntriesTree([
      { path: "docs", kind: "directory" },
      { path: "src/index.ts", kind: "file" },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "docs",
        path: "docs",
        children: [],
      },
      {
        kind: "directory",
        name: "src",
        path: "src",
        children: [
          {
            kind: "file",
            name: "index.ts",
            path: "src/index.ts",
          },
        ],
      },
    ]);
  });

  it("normalizes windows separators and deduplicates files", () => {
    const tree = buildProjectEntriesTree([
      { path: "apps\\web\\src\\main.tsx", kind: "file" },
      { path: "apps/web/src/main.tsx", kind: "file" },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/web/src",
        path: "apps/web/src",
        children: [
          {
            kind: "file",
            name: "main.tsx",
            path: "apps/web/src/main.tsx",
          },
        ],
      },
    ]);
  });
});
