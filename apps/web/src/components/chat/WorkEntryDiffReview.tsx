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
import { Button } from "../ui/button";
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
  entry: Pick<WorkLogEntry, "id" | "turnId" | "changedFiles" | "unifiedDiff">;
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
    return (entry.changedFiles ?? []).map<ReviewFileRow>((path) => ({
      fileKey: path,
      path,
      previousPath: null,
      additions: 0,
      deletions: 0,
      status: "updated" as const,
    }));
  }, [diffFiles, entry.changedFiles]);
  const fallbackFiles = entry.changedFiles ?? [];
  const hasInlineDiff = diffFiles.length > 0;
  const hasFallbackFiles = fallbackFiles.length > 0;
  const [openFilePath, setOpenFilePath] = useState<string | null>(() =>
    diffFiles.length === 1 ? resolveFileDiffPath(diffFiles[0]!) : null,
  );
  const [rawPatchOpen, setRawPatchOpen] = useState(false);
  const primaryFilePath = reviewFiles[0]?.path ?? null;
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
    <div className="mt-2 rounded-xl border border-border/60 bg-background/55 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
            File review
          </p>
          <p className="truncate text-[11px] text-muted-foreground/75">
            {hasInlineDiff
              ? `${reviewFiles.length} file${reviewFiles.length === 1 ? "" : "s"} changed`
              : hasFallbackFiles
                ? `${fallbackFiles.length} file${fallbackFiles.length === 1 ? "" : "s"} updated`
                : "Raw patch"}
          </p>
        </div>
        {turnId && primaryFilePath && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnId, primaryFilePath)}
          >
            <ExternalLinkIcon className="size-3" />
            Open diff
          </Button>
        )}
      </div>

      {(hasInlineDiff || hasFallbackFiles) && (
        <div className="mt-2 space-y-2">
          {reviewFiles.map((file) => {
            const fileDiff = file.fileDiff;
            const path = file.path;
            const isOpen = openFilePath === path;
            const { directory, filename } = splitPath(path);
            const previousPath =
              file.previousPath && file.previousPath !== path ? file.previousPath : null;
            const hasInlinePreview = Boolean(fileDiff);
            return (
              <div
                key={`${file.fileKey}:${path}`}
                className="overflow-hidden rounded-lg border border-border/65 bg-card/65"
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-background/60"
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
                      "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
                      hasInlinePreview ? isOpen && "rotate-90" : "opacity-40",
                    )}
                  />
                  <VscodeEntryIcon
                    pathValue={path}
                    kind="file"
                    theme={resolvedTheme}
                    className="size-3.5 shrink-0 text-muted-foreground/75"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[11px] text-foreground/88">{filename}</p>
                    {directory && (
                      <p className="truncate font-mono text-[10px] text-muted-foreground/60">
                        {directory}
                      </p>
                    )}
                    {previousPath && (
                      <p className="truncate font-mono text-[10px] text-muted-foreground/55">
                        from {previousPath}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-[10px] font-medium">
                    {file.status === "modified" ? (
                      <DiffStatLabel additions={file.additions} deletions={file.deletions} />
                    ) : (
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5",
                          file.status === "added" &&
                            "bg-success/12 text-success ring-1 ring-inset ring-success/20",
                          file.status === "deleted" &&
                            "bg-destructive/12 text-destructive ring-1 ring-inset ring-destructive/20",
                          file.status === "moved" &&
                            "bg-sky-500/12 text-sky-600 ring-1 ring-inset ring-sky-500/20 dark:text-sky-400",
                          file.status === "updated" &&
                            "bg-muted text-muted-foreground ring-1 ring-inset ring-border/70",
                        )}
                      >
                        {statusBadge(file.status)}
                      </span>
                    )}
                  </div>
                </button>
                {isOpen && fileDiff && (
                  <div className="border-t border-border/65 bg-background/50 p-2">
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
          <div className="mt-2 rounded-lg border border-border/65 bg-card/65 p-2.5">
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-[11px] text-muted-foreground/75"
              onClick={() => setRawPatchOpen((open) => !open)}
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  rawPatchOpen && "rotate-90",
                )}
              />
              <FileCode2Icon className="size-3.5 shrink-0" />
              <span className="truncate">Show raw patch</span>
              <span className="truncate text-muted-foreground/55">{renderablePatch.reason}</span>
            </button>
            <CollapsibleContent>
              {rawPatchOpen && (
                <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border/60 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                  {renderablePatch.text}
                </pre>
              )}
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
    </div>
  );
});
