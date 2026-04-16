import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { openInPreferredEditor } from "~/editorPreferences";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";
import { resolvePathLinkTarget } from "~/terminal-links";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

function projectFileQueryKey(
  environmentId: EnvironmentId,
  cwd: string | null,
  relativePath: string | null,
) {
  return ["project-file", environmentId, cwd, relativePath] as const;
}

export function ProjectFileEditorDialog(props: {
  environmentId: EnvironmentId;
  cwd: string | null;
  relativePath: string | null;
  onClose: () => void;
}) {
  const { environmentId, cwd, relativePath, onClose } = props;
  const queryClient = useQueryClient();
  const [draftState, setDraftState] = useState<{ relativePath: string | null; contents: string }>({
    relativePath: null,
    contents: "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const isOpen = relativePath !== null;
  const queryKey = useMemo(
    () => projectFileQueryKey(environmentId, cwd, relativePath),
    [cwd, environmentId, relativePath],
  );
  const fileQuery = useQuery({
    queryKey,
    enabled: isOpen && cwd !== null && relativePath !== null,
    queryFn: async () => {
      if (!cwd || !relativePath) {
        throw new Error("Workspace path is unavailable for this file.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment API is unavailable for this thread.");
      }
      return api.projects.readFile({
        cwd,
        relativePath,
      });
    },
  });

  useEffect(() => {
    if (!relativePath) {
      setDraftState({ relativePath: null, contents: "" });
    }
  }, [relativePath]);

  useEffect(() => {
    if (!relativePath || !fileQuery.data) {
      return;
    }
    setDraftState((current) => {
      if (current.relativePath !== fileQuery.data.relativePath) {
        return {
          relativePath: fileQuery.data.relativePath,
          contents: fileQuery.data.contents,
        };
      }
      if (current.contents !== fileQuery.data.contents) {
        return current;
      }
      return current;
    });
  }, [fileQuery.data, relativePath]);

  const draftContents = draftState.relativePath === relativePath ? draftState.contents : "";
  const isDirty =
    relativePath !== null &&
    fileQuery.data?.relativePath === relativePath &&
    draftState.relativePath === relativePath &&
    draftContents !== fileQuery.data.contents;

  const handleOpenInEditor = async () => {
    if (!cwd || !relativePath) {
      return;
    }

    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Could not open file",
        description: "The local desktop bridge is unavailable.",
      });
      return;
    }

    try {
      await openInPreferredEditor(api, resolvePathLinkTarget(relativePath, cwd));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open file",
        description: error instanceof Error ? error.message : "Failed to open the selected file.",
      });
    }
  };

  const handleSave = () => {
    if (!cwd || !relativePath) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Could not save file",
        description: "Environment API is unavailable for this thread.",
      });
      return;
    }

    setIsSaving(true);
    void api.projects
      .writeFile({
        cwd,
        relativePath,
        contents: draftContents,
      })
      .then((result) => {
        queryClient.setQueryData(queryKey, {
          relativePath: result.relativePath,
          contents: draftContents,
        });
        toastManager.add({
          type: "success",
          title: "File saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: error instanceof Error ? error.message : "Failed to save the selected file.",
        });
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isSaving) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{relativePath ?? "Workspace file"}</DialogTitle>
          <DialogDescription>
            Edit the file inline and save the changes back to the current workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false} className="space-y-3">
          {relativePath ? (
            <div className="rounded-md border border-border/70 bg-muted/10 px-3 py-2 font-mono text-xs text-foreground/80">
              {relativePath}
            </div>
          ) : null}
          {fileQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full rounded-md" />
              <Skeleton className="h-[28rem] w-full rounded-xl" />
            </div>
          ) : fileQuery.isError ? (
            <div className="rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {fileQuery.error instanceof Error
                ? fileQuery.error.message
                : "Failed to load the selected file."}
            </div>
          ) : (
            <Textarea
              value={draftContents}
              onChange={(event) => {
                if (!relativePath) {
                  return;
                }
                setDraftState({
                  relativePath,
                  contents: event.target.value,
                });
              }}
              className="h-[min(70vh,42rem)] font-mono"
              rows={24}
              spellCheck={false}
              autoFocus
              aria-label={relativePath ? `Edit ${relativePath}` : "Edit file"}
            />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleOpenInEditor()}
            disabled={!relativePath || isSaving}
          >
            Open in editor
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={isSaving || fileQuery.isLoading || fileQuery.isError || !isDirty}
          >
            {isSaving ? "Saving..." : isDirty ? "Save changes" : "Saved"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
