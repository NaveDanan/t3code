import type { EnvironmentId, ProjectSearchTextFileResult, ProjectEntry } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  ChevronRightIcon,
  FolderClosedIcon,
  FolderIcon,
  SearchCodeIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";

import { openInPreferredEditor } from "~/editorPreferences";
import { readLocalApi } from "~/localApi";
import {
  projectSearchEntriesQueryOptions,
  projectSearchTextQueryOptions,
} from "~/lib/projectReactQuery";
import { buildProjectEntriesTree, type ProjectEntriesTreeNode } from "~/lib/projectEntriesTree";
import { resolvePathLinkTarget } from "~/terminal-links";
import { cn } from "~/lib/utils";

import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Sheet, SheetPopup } from "./ui/sheet";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";
import { toastManager } from "./ui/toast";

export const FILES_PANEL_SHEET_MEDIA_QUERY = "(max-width: 1180px)";

const FILES_PANEL_STORAGE_KEY = "chat_project_files_sidebar_width";
const FILES_PANEL_DEFAULT_WIDTH = "clamp(18rem,24vw,26rem)";
const FILES_PANEL_MIN_WIDTH = 18 * 16;
const FILES_PANEL_FETCH_LIMIT = 5000;
const FILES_PANEL_QUERY_DEBOUNCE_MS = 120;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
const EMPTY_PROJECT_ENTRIES: ReadonlyArray<ProjectEntry> = [];
const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export function acceptInlineThreadPanelWidth(options: {
  nextWidth: number;
  wrapper: HTMLElement;
}): boolean {
  const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
  if (!composerForm) return true;
  const composerViewport = composerForm.parentElement;
  if (!composerViewport) return true;
  const previousSidebarWidth = options.wrapper.style.getPropertyValue("--sidebar-width");
  options.wrapper.style.setProperty("--sidebar-width", `${options.nextWidth}px`);

  const viewportStyle = window.getComputedStyle(composerViewport);
  const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
  const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
  const viewportContentWidth = Math.max(
    0,
    composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
  );
  const formRect = composerForm.getBoundingClientRect();
  const composerFooter = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-footer='true']",
  );
  const composerRightActions = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-actions='right']",
  );
  const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
  const composerFooterGap = composerFooter
    ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
      Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
      0
    : 0;
  const minimumComposerWidth =
    COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
  const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
  const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
  const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

  if (previousSidebarWidth.length > 0) {
    options.wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
  } else {
    options.wrapper.style.removeProperty("--sidebar-width");
  }

  return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
}

function highlightName(name: string, query: string | undefined): React.ReactNode {
  if (!query || query.length === 0) return name;
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let searchFrom = 0;
  while (searchFrom < lowerName.length) {
    const matchIndex = lowerName.indexOf(lowerQuery, searchFrom);
    if (matchIndex === -1) break;
    if (matchIndex > lastIndex) {
      parts.push(name.slice(lastIndex, matchIndex));
    }
    parts.push(
      <mark key={matchIndex} className="bg-yellow-500/40 dark:bg-yellow-500/30 rounded-xs">
        {name.slice(matchIndex, matchIndex + query.length)}
      </mark>,
    );
    lastIndex = matchIndex + query.length;
    searchFrom = lastIndex;
  }
  if (lastIndex === 0) return name;
  if (lastIndex < name.length) {
    parts.push(name.slice(lastIndex));
  }
  return <>{parts}</>;
}

function highlightLineText(
  text: string,
  query: string,
  submatches?: ReadonlyArray<{ start: number; end: number }>,
): React.ReactNode {
  if (submatches && submatches.length > 0) {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    for (const submatch of submatches) {
      if (submatch.start > lastIndex) {
        parts.push(text.slice(lastIndex, submatch.start));
      }
      parts.push(
        <mark
          key={`${submatch.start}-${submatch.end}`}
          className="bg-yellow-500/40 dark:bg-yellow-500/30"
        >
          {text.slice(submatch.start, submatch.end)}
        </mark>,
      );
      lastIndex = submatch.end;
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }
    return <>{parts}</>;
  }
  return highlightName(text, query);
}

const ProjectFilesTree = memo(function ProjectFilesTree(props: {
  entries: ReadonlyArray<ProjectEntry>;
  allDirectoriesExpanded: boolean;
  cwd: string;
  resolvedTheme: "light" | "dark";
  searchQuery?: string;
  textSearchFiles?: ReadonlyArray<ProjectSearchTextFileResult>;
}) {
  const treeNodes = useMemo(() => buildProjectEntriesTree(props.entries), [props.entries]);
  const textMatchesByPath = useMemo(() => {
    if (!props.textSearchFiles || props.textSearchFiles.length === 0) return undefined;
    const map = new Map<string, ProjectSearchTextFileResult>();
    for (const file of props.textSearchFiles) {
      map.set(file.path, file);
    }
    return map;
  }, [props.textSearchFiles]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const expansionStateKey = `${props.allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? props.allDirectoriesExpanded),
          },
        };
      });
    },
    [expansionStateKey, props.allDirectoriesExpanded],
  );

  const openFile = useCallback(
    async (pathValue: string) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      try {
        await openInPreferredEditor(api, resolvePathLinkTarget(pathValue, props.cwd));
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not open file",
          description: error instanceof Error ? error.message : "Failed to open the selected file.",
        });
      }
    },
    [props.cwd],
  );

  const renderTreeNode = useCallback(
    (node: ProjectEntriesTreeNode, depth: number) => {
      const leftPadding = 10 + depth * 14;
      if (node.kind === "directory") {
        const isExpanded = expandedDirectories[node.path] ?? props.allDirectoriesExpanded;
        return (
          <div key={`dir:${node.path}`}>
            <button
              type="button"
              className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-accent/50"
              style={{ paddingLeft: `${leftPadding}px` }}
              onClick={() => toggleDirectory(node.path)}
            >
              <ChevronRightIcon
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                  isExpanded && "rotate-90",
                )}
              />
              {isExpanded ? (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
              ) : (
                <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
              )}
              <span className="truncate font-mono text-[11px] text-foreground/90">
                {highlightName(node.name, props.searchQuery)}
              </span>
            </button>
            {isExpanded ? (
              <div className="space-y-0.5">
                {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
              </div>
            ) : null}
          </div>
        );
      }

      const fileTextMatches = textMatchesByPath?.get(node.path);
      return (
        <div key={`file:${node.path}`}>
          <button
            type="button"
            className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-accent/50"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => {
              void openFile(node.path);
            }}
          >
            <span aria-hidden="true" className="size-3.5 shrink-0" />
            <VscodeEntryIcon
              pathValue={node.path}
              kind="file"
              theme={props.resolvedTheme}
              className="size-3.5"
            />
            <span className="truncate font-mono text-[11px] text-foreground/85">
              {highlightName(node.name, props.searchQuery)}
            </span>
            {fileTextMatches && fileTextMatches.matches.length > 0 ? (
              <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                {fileTextMatches.matches.length}
              </span>
            ) : null}
          </button>
          {fileTextMatches && fileTextMatches.matches.length > 0 ? (
            <div className="space-y-px" style={{ paddingLeft: `${leftPadding + 18}px` }}>
              {fileTextMatches.matches.map((match) => (
                <button
                  key={`${node.path}:${match.lineNumber}`}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md py-0.5 pr-2 text-left hover:bg-accent/40"
                  onClick={() => {
                    void openFile(`${node.path}:${match.lineNumber}`);
                  }}
                >
                  <span className="w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
                    {match.lineNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/70">
                    {highlightLineText(match.lineText, props.searchQuery ?? "", match.submatches)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      );
    },
    [
      expandedDirectories,
      openFile,
      props.allDirectoriesExpanded,
      props.resolvedTheme,
      props.searchQuery,
      textMatchesByPath,
      toggleDirectory,
    ],
  );

  return <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>;
});

export function ProjectFilesPanel(props: {
  environmentId: EnvironmentId;
  cwd: string | null;
  visible: boolean;
  resolvedTheme: "light" | "dark";
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, { wait: FILES_PANEL_QUERY_DEBOUNCE_MS });
  const normalizedQuery = query.trim();
  const showSearchResults = normalizedQuery.length > 0;
  const projectEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      query: showSearchResults ? debouncedQuery : "",
      allowEmptyQuery: true,
      enabled: props.visible,
      limit: FILES_PANEL_FETCH_LIMIT,
    }),
  );
  const projectTextSearchQuery = useQuery(
    projectSearchTextQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      query: debouncedQuery,
      enabled: props.visible && showSearchResults,
    }),
  );
  const entries = projectEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const textSearchFiles = projectTextSearchQuery.data?.files ?? [];
  const mergedEntries = useMemo(() => {
    if (!showSearchResults || textSearchFiles.length === 0) return entries;
    const existingPaths = new Set(entries.map((e) => e.path));
    const extraEntries = textSearchFiles
      .filter((f) => !existingPaths.has(f.path))
      .map((f) => ({ path: f.path, kind: "file" as const }));
    return extraEntries.length > 0 ? [...entries, ...extraEntries] : entries;
  }, [entries, textSearchFiles, showSearchResults]);
  const allDirectoriesExpanded = false;
  const isInitialLoading = showSearchResults
    ? projectTextSearchQuery.isLoading &&
      textSearchFiles.length === 0 &&
      projectEntriesQuery.isLoading &&
      entries.length === 0
    : projectEntriesQuery.isLoading && entries.length === 0;
  const matchingFileNameCount = showSearchResults ? mergedEntries.length : 0;
  const activeQuery = showSearchResults ? projectTextSearchQuery : projectEntriesQuery;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
      <div className="border-b border-border px-3 py-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search in files"
            className="h-8 pr-8 pl-8 text-xs"
            aria-label="Search in project files"
          />
          {query.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setQuery("")}
              aria-label="Clear file search"
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        {activeQuery.data?.truncated ? (
          <div className="mt-2 text-[11px] text-muted-foreground">
            {showSearchResults
              ? "Showing a truncated set of matching files. Refine the search to narrow the results."
              : `Showing the first ${FILES_PANEL_FETCH_LIMIT.toLocaleString()} matching entries. Refine the search to narrow the list.`}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {isInitialLoading ? (
          <div className="space-y-1.5 px-1 py-1">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="flex items-center gap-2 px-2 py-1">
                <Skeleton className="size-3.5 shrink-0 rounded-sm" />
                <Skeleton className="h-3 w-32 rounded-full" />
              </div>
            ))}
          </div>
        ) : activeQuery.isError ? (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {activeQuery.error instanceof Error
              ? activeQuery.error.message
              : "Failed to load workspace files."}
          </div>
        ) : !props.cwd ? (
          <div className="rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
            This thread does not have an active workspace path yet.
          </div>
        ) : showSearchResults ? (
          textSearchFiles.length === 0 && matchingFileNameCount === 0 ? (
            <div className="rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <SearchCodeIcon className="size-3.5 shrink-0" />
                <span>No matches found for &ldquo;{normalizedQuery}&rdquo;.</span>
              </div>
            </div>
          ) : (
            <ProjectFilesTree
              entries={mergedEntries}
              allDirectoriesExpanded
              cwd={props.cwd}
              resolvedTheme={props.resolvedTheme}
              searchQuery={normalizedQuery}
              textSearchFiles={textSearchFiles}
            />
          )
        ) : entries.length === 0 ? (
          <div className="rounded-md border border-border/70 bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
            No files were indexed for this workspace.
          </div>
        ) : (
          <ProjectFilesTree
            entries={entries}
            allDirectoriesExpanded={allDirectoriesExpanded}
            cwd={props.cwd}
            resolvedTheme={props.resolvedTheme}
          />
        )}
      </div>
    </div>
  );
}

export function ProjectFilesPanelInlineSidebar(props: {
  filesOpen: boolean;
  onCloseFiles: () => void;
  onOpenFiles: () => void;
  environmentId: EnvironmentId;
  cwd: string | null;
  resolvedTheme: "light" | "dark";
}) {
  const { filesOpen, onCloseFiles, onOpenFiles, environmentId, cwd, resolvedTheme } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenFiles();
        return;
      }
      onCloseFiles();
    },
    [onCloseFiles, onOpenFiles],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={filesOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": FILES_PANEL_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: FILES_PANEL_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            acceptInlineThreadPanelWidth({ nextWidth, wrapper }),
          storageKey: FILES_PANEL_STORAGE_KEY,
        }}
      >
        <ProjectFilesPanel
          environmentId={environmentId}
          cwd={cwd}
          visible={filesOpen}
          resolvedTheme={resolvedTheme}
        />
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}

export function ProjectFilesPanelSheet(props: {
  filesOpen: boolean;
  onCloseFiles: () => void;
  environmentId: EnvironmentId;
  cwd: string | null;
  resolvedTheme: "light" | "dark";
}) {
  return (
    <Sheet
      open={props.filesOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseFiles();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,420px)] max-w-[420px] p-0"
      >
        <ProjectFilesPanel
          environmentId={props.environmentId}
          cwd={props.cwd}
          visible={props.filesOpen}
          resolvedTheme={props.resolvedTheme}
        />
      </SheetPopup>
    </Sheet>
  );
}

function collectDirectoryPaths(nodes: ReadonlyArray<ProjectEntriesTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") {
      continue;
    }
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
