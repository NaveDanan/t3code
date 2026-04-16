import type { ProjectEntry } from "@t3tools/contracts";

export interface ProjectEntriesTreeDirectoryNode {
  kind: "directory";
  name: string;
  path: string;
  children: ProjectEntriesTreeNode[];
}

export interface ProjectEntriesTreeFileNode {
  kind: "file";
  name: string;
  path: string;
}

export type ProjectEntriesTreeNode = ProjectEntriesTreeDirectoryNode | ProjectEntriesTreeFileNode;

interface MutableDirectoryNode {
  name: string;
  path: string;
  directories: Map<string, MutableDirectoryNode>;
  files: Map<string, ProjectEntriesTreeFileNode>;
}

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, SORT_LOCALE_OPTIONS);
}

function compactDirectoryNode(
  node: ProjectEntriesTreeDirectoryNode,
): ProjectEntriesTreeDirectoryNode {
  const compactedChildren = node.children.map((child) =>
    child.kind === "directory" ? compactDirectoryNode(child) : child,
  );

  let compactedNode: ProjectEntriesTreeDirectoryNode = {
    ...node,
    children: compactedChildren,
  };

  while (compactedNode.children.length === 1 && compactedNode.children[0]?.kind === "directory") {
    const onlyChild = compactedNode.children[0];
    compactedNode = {
      kind: "directory",
      name: `${compactedNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      children: onlyChild.children,
    };
  }

  return compactedNode;
}

function toTreeNodes(directory: MutableDirectoryNode): ProjectEntriesTreeNode[] {
  const subdirectories = Array.from(directory.directories.values())
    .toSorted(compareByName)
    .map<ProjectEntriesTreeDirectoryNode>((subdirectory) => ({
      kind: "directory",
      name: subdirectory.name,
      path: subdirectory.path,
      children: toTreeNodes(subdirectory),
    }))
    .map((subdirectory) => compactDirectoryNode(subdirectory));

  const files = Array.from(directory.files.values()).toSorted(compareByName);
  return [...subdirectories, ...files];
}

function ensureDirectoryPath(
  root: MutableDirectoryNode,
  pathValue: string,
): MutableDirectoryNode | null {
  const segments = normalizePathSegments(pathValue);
  if (segments.length === 0) {
    return null;
  }

  let currentDirectory = root;
  for (const segment of segments) {
    const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
    const existing = currentDirectory.directories.get(segment);
    if (existing) {
      currentDirectory = existing;
      continue;
    }

    const created: MutableDirectoryNode = {
      name: segment,
      path: nextPath,
      directories: new Map(),
      files: new Map(),
    };
    currentDirectory.directories.set(segment, created);
    currentDirectory = created;
  }

  return currentDirectory;
}

export function buildProjectEntriesTree(
  entries: ReadonlyArray<ProjectEntry>,
): ProjectEntriesTreeNode[] {
  const root: MutableDirectoryNode = {
    name: "",
    path: "",
    directories: new Map(),
    files: new Map(),
  };

  for (const entry of entries) {
    const segments = normalizePathSegments(entry.path);
    if (segments.length === 0) {
      continue;
    }

    if (entry.kind === "directory") {
      ensureDirectoryPath(root, entry.path);
      continue;
    }

    const fileName = segments.at(-1);
    if (!fileName) {
      continue;
    }

    const parentDirectory =
      segments.length > 1 ? ensureDirectoryPath(root, segments.slice(0, -1).join("/")) : root;
    if (!parentDirectory) {
      continue;
    }

    parentDirectory.files.set(fileName, {
      kind: "file",
      name: fileName,
      path: segments.join("/"),
    });
  }

  return toTreeNodes(root);
}
