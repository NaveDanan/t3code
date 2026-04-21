import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ChevronRightIcon, ExternalLinkIcon, FileCode2Icon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { WorkLogEntry } from "../../session-logic";
import {
  buildFileDiffRenderKey,
  DIFF_SURFACE_UNSAFE_CSS,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { DiffStatLabel } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

type DiffThemeType = "light" | "dark";
type ReviewFileStatus = "added" | "deleted" | "modified" | "moved" | "updated";
interface ReviewFileRow {
  readonly fileKey: string;
  readonly path: string;
  readonly previousPath: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly status: ReviewFileStatus;
  readonly fileDiff?: FileDiffMetadata;
}

function splitPath(pathValue: string): { directory: string | null; filename: string } {
  const normalized = pathValue.replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex < 0) {
    return { directory: null, filename: normalized };
  }
  return {
    directory: normalized.slice(0, separatorIndex),
    filename: normalized.slice(separatorIndex + 1),
  };
}

function resolvePreviousFileDiffPath(fileDiff: { prevName?: string }): string | null {
  const raw = fileDiff.prevName ?? "";
  if (raw.length === 0) {
    return null;
  }
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function normalizeReviewFileStatus(type: string): ReviewFileStatus {
  if (type === "new") return "added";
  if (type === "deleted") return "deleted";
  if (type === "rename-pure" || type === "rename-changed") return "moved";
  return "modified";
}

function statusBadge(status: Exclude<ReviewFileStatus, "modified">): string {
  if (status === "added") return "Created";
  if (status === "deleted") return "Deleted";
  if (status === "updated") return "Updated";
  return "Moved";
}

export const WorkEntryDiffReview = memo(function WorkEntryDiffReview(props: {
  entry: Pick<WorkLogEntry, "id" | "turnId" | "changedFiles" | "changedFileStats" | "unifiedDiff">;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: NonNullable<WorkLogEntry["turnId"]>, filePath?: string) => void;
  onLayoutChange?: () => void;
}) {
  const { entry, onLayoutChange, onOpenTurnDiff, resolvedTheme } = props;
  const renderablePatch = useMemo(
    () => getRenderablePatch(entry.unifiedDiff, `work-entry:${entry.id}`),
    [entry.id, entry.unifiedDiff],
  );
  const diffFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files;
  }, [renderablePatch]);
  const reviewFiles = useMemo(() => {
    if (diffFiles.length > 0) {
      return diffFiles.map<ReviewFileRow>((fileDiff) => ({
        fileDiff,
        fileKey: buildFileDiffRenderKey(fileDiff),
        path: resolveFileDiffPath(fileDiff),
        previousPath: resolvePreviousFileDiffPath(fileDiff),
        additions: fileDiff.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
        deletions: fileDiff.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
        status: normalizeReviewFileStatus(fileDiff.type),
      }));
    }
    if ((entry.changedFileStats?.length ?? 0) > 0) {
      return entry.changedFileStats!.map<ReviewFileRow>((file) => ({
        fileKey: file.path,
        path: file.path,
        previousPath: file.previousPath ?? null,
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
      }));
    }
    return (entry.changedFiles ?? []).map<ReviewFileRow>((path) => ({
      fileKey: path,
      path,
      previousPath: null,
      additions: 0,
      deletions: 0,
      status: "updated" as const,
    }));
  }, [diffFiles, entry.changedFileStats, entry.changedFiles]);
  const fallbackFiles = entry.changedFileStats ?? entry.changedFiles ?? [];
  const hasInlineDiff = diffFiles.length > 0;
  const hasFallbackFiles = fallbackFiles.length > 0;
  const [openFilePath, setOpenFilePath] = useState<string | null>(() =>
    diffFiles.length === 1 ? resolveFileDiffPath(diffFiles[0]!) : null,
  );
  const [rawPatchOpen, setRawPatchOpen] = useState(false);
  const turnId = entry.turnId;

  useEffect(() => {
    const validPaths = new Set(diffFiles.map((fileDiff) => resolveFileDiffPath(fileDiff)));
    if (validPaths.size === 0) {
      setOpenFilePath(null);
      return;
    }
    setOpenFilePath((current) =>
      current && validPaths.has(current)
        ? current
        : validPaths.size === 1
          ? [...validPaths][0]!
          : null,
    );
  }, [diffFiles]);

  useEffect(() => {
    onLayoutChange?.();
  }, [onLayoutChange, openFilePath, rawPatchOpen, renderablePatch]);

  if (!hasInlineDiff && !hasFallbackFiles && renderablePatch?.kind !== "raw") {
    return null;
  }

  return (
    <div className="mt-1.5">
      {(hasInlineDiff || hasFallbackFiles) && (
        <div className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/50">
          {reviewFiles.map((file) => {
            const fileDiff = file.fileDiff;
            const path = file.path;
            const isOpen = openFilePath === path;
            const { directory, filename } = splitPath(path);
            const previousPath =
              file.previousPath && file.previousPath !== path ? file.previousPath : null;
            const hasInlinePreview = Boolean(fileDiff);
            return (
              <div key={`${file.fileKey}:${path}`} className="overflow-hidden">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
                  onClick={() => {
                    if (!hasInlinePreview) {
                      if (turnId) {
                        onOpenTurnDiff(turnId, path);
                      }
                      return;
                    }
                    setOpenFilePath((current) => (current === path ? null : path));
                  }}
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3 shrink-0 text-muted-foreground/60 transition-transform",
                      hasInlinePreview ? isOpen && "rotate-90" : "opacity-30",
                    )}
                  />
                  <VscodeEntryIcon
                    pathValue={path}
                    kind="file"
                    theme={resolvedTheme}
                    className="size-3.5 shrink-0 text-muted-foreground/70"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-[11px] text-foreground/85">{filename}</span>
                    {directory && (
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/50">
                        {directory}
                      </span>
                    )}
                    {previousPath && (
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/50">
                        ← {previousPath}
                      </span>
                    )}
                  </div>
                  <div className="shrink-0 text-[10px] font-medium">
                    {file.status === "modified" ? (
                      <DiffStatLabel additions={file.additions} deletions={file.deletions} />
                    ) : (
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5",
                          file.status === "added" &&
                            "bg-success/10 text-success ring-1 ring-inset ring-success/20",
                          file.status === "deleted" &&
                            "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20",
                          file.status === "moved" &&
                            "bg-sky-500/10 text-sky-600 ring-1 ring-inset ring-sky-500/20 dark:text-sky-400",
                          file.status === "updated" &&
                            "text-muted-foreground ring-1 ring-inset ring-border/60",
                        )}
                      >
                        {statusBadge(file.status)}
                      </span>
                    )}
                  </div>
                  {!hasInlinePreview && turnId && (
                    <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground/40" />
                  )}
                </button>
                {isOpen && fileDiff && (
                  <div className="border-t border-border/40">
                    <FileDiff
                      fileDiff={fileDiff}
                      options={{
                        diffStyle: "unified",
                        lineDiffType: "none",
                        overflow: "wrap",
                        theme: resolveDiffThemeName(resolvedTheme),
                        themeType: resolvedTheme as DiffThemeType,
                        unsafeCSS: DIFF_SURFACE_UNSAFE_CSS,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {renderablePatch?.kind === "raw" && (
        <Collapsible open={rawPatchOpen} onOpenChange={setRawPatchOpen}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-muted-foreground/70 transition-colors hover:bg-muted/40"
            onClick={() => setRawPatchOpen((open) => !open)}
          >
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", rawPatchOpen && "rotate-90")}
            />
            <FileCode2Icon className="size-3.5 shrink-0" />
            <span className="truncate">Show raw patch</span>
            <span className="truncate text-muted-foreground/45">{renderablePatch.reason}</span>
          </button>
          <CollapsibleContent>
            {rawPatchOpen && (
              <pre className="mt-1 max-h-[28rem] overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border/50 bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground/85">
                {renderablePatch.text}
              </pre>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
});
