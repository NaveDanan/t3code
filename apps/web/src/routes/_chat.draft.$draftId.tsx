import { scopeProjectRef } from "@t3tools/client-runtime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { ProjectFilesPanel } from "../components/ProjectFilesPanel";
import { ThreadRightPanelInlineSidebar, type RightPanelTab } from "../components/ThreadRightPanel";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import {
  getStoredRightPanelTab,
  parseDiffRouteSearch,
  saveRightPanelTab,
  updateRightPanelSearch,
} from "../diffRouteSearch";

import { useTheme } from "../hooks/useTheme";
import { SidebarInset } from "../components/ui/sidebar";
import {
  createProjectSelectorByRef,
  createThreadSelectorAcrossEnvironments,
} from "../storeSelectors";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const search = Route.useSearch();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const projectRef = useMemo(
    () =>
      draftSession ? scopeProjectRef(draftSession.environmentId, draftSession.projectId) : null,
    [draftSession],
  );
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStarted = threadHasStarted(serverThread);
  const rightPanelOpen = search.rightPanel === "1";
  const rightPanelTab = search.rightPanelTab ?? getStoredRightPanelTab();

  const { resolvedTheme } = useTheme();
  const canonicalThreadRef = useMemo(
    () =>
      draftSession?.promotedTo
        ? serverThreadStarted
          ? draftSession.promotedTo
          : null
        : serverThread
          ? {
              environmentId: serverThread.environmentId,
              threadId: serverThread.id,
            }
          : null,
    [draftSession?.promotedTo, serverThread, serverThreadStarted],
  );
  const setRightPanelOpen = useCallback(
    (open: boolean) => {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: true,
        search: (previous) =>
          updateRightPanelSearch({
            previous,
            open,
            fallbackTab: getStoredRightPanelTab(),
          }),
      });
    },
    [draftId, navigate],
  );
  const setRightPanelTab = useCallback(
    (tab: RightPanelTab) => {
      saveRightPanelTab(tab);
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: true,
        search: (previous) =>
          updateRightPanelSearch({
            previous,
            open: true,
            tab,
          }),
      });
    },
    [draftId, navigate],
  );

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
      search: rightPanelOpen
        ? {
            rightPanel: "1",
            rightPanelTab,
          }
        : {},
    });
  }, [canonicalThreadRef, navigate, rightPanelOpen, rightPanelTab]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  const filesContent = (
    <ProjectFilesPanel
      environmentId={draftSession.environmentId}
      cwd={project?.cwd ?? null}
      visible={rightPanelOpen && rightPanelTab === "files"}
      resolvedTheme={resolvedTheme}
    />
  );
  const diffContent = (
    <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
      Diffs are available after this draft is promoted to a server thread.
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatView
        draftId={draftId}
        environmentId={draftSession.environmentId}
        threadId={draftSession.threadId}
        routeKind="draft"
        rightPanel={
          <ThreadRightPanelInlineSidebar
            open={rightPanelOpen}
            activeTab={rightPanelTab}
            onOpenChange={setRightPanelOpen}
            onTabChange={setRightPanelTab}
            diffContent={diffContent}
            filesContent={filesContent}
          />
        }
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: DraftChatThreadRouteView,
});
