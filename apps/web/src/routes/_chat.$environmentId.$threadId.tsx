import { scopeProjectRef } from "@t3tools/client-runtime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import ChatSplitView from "../components/ChatSplitView";
import { threadHasStarted } from "../components/ChatView.logic";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { ProjectFilesPanel } from "../components/ProjectFilesPanel";
import { ThreadRightPanelInlineSidebar, type RightPanelTab } from "../components/ThreadRightPanel";
import { finalizePromotedDraftThreadByRef, useComposerDraftStore } from "../composerDraftStore";
import {
  getStoredRightPanelTab,
  parseDiffRouteSearch,
  saveRightPanelTab,
  updateRightPanelSearch,
} from "../diffRouteSearch";

import { useTheme } from "../hooks/useTheme";
import { selectEnvironmentState, selectThreadByRef, useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { SidebarInset } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

function ChatThreadRouteView() {
  const navigate = useNavigate();
  const threadRef = Route.useParams({
    select: (params) => resolveThreadRouteRef(params),
  });
  const search = Route.useSearch();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).bootstrapComplete,
  );
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const threadExists = useStore((store) => selectThreadByRef(store, threadRef) !== undefined);
  const environmentHasServerThreads = useStore(
    (store) => selectEnvironmentState(store, threadRef?.environmentId ?? null).threadIds.length > 0,
  );
  const draftThreadExists = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) !== null : false,
  );
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const projectRef = useMemo(() => {
    if (serverThread) {
      return scopeProjectRef(serverThread.environmentId, serverThread.projectId);
    }
    if (draftThread) {
      return scopeProjectRef(draftThread.environmentId, draftThread.projectId);
    }
    return null;
  }, [draftThread, serverThread]);
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const { resolvedTheme } = useTheme();
  const environmentHasDraftThreads = useComposerDraftStore((store) => {
    if (!threadRef) {
      return false;
    }
    return store.hasDraftThreadsInEnvironment(threadRef.environmentId);
  });
  const routeThreadExists = threadExists || draftThreadExists;
  const serverThreadStarted = threadHasStarted(serverThread);
  const environmentHasAnyThreads = environmentHasServerThreads || environmentHasDraftThreads;
  const rightPanelOpen = search.rightPanel === "1";
  const rightPanelTab = search.rightPanelTab ?? getStoredRightPanelTab();
  const [hasOpenedDiffTab, setHasOpenedDiffTab] = useState(rightPanelTab === "diff");
  const setRightPanelOpen = useCallback(
    (open: boolean) => {
      if (!threadRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) =>
          updateRightPanelSearch({
            previous,
            open,
            fallbackTab: getStoredRightPanelTab(),
          }),
      });
    },
    [navigate, threadRef],
  );
  const setRightPanelTab = useCallback(
    (tab: RightPanelTab) => {
      if (!threadRef) {
        return;
      }
      saveRightPanelTab(tab);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        search: (previous) =>
          updateRightPanelSearch({
            previous,
            open: true,
            tab,
          }),
      });
    },
    [navigate, threadRef],
  );

  useEffect(() => {
    if (rightPanelTab === "diff") {
      setHasOpenedDiffTab(true);
    }
  }, [rightPanelTab]);

  useEffect(() => {
    if (!threadRef || !bootstrapComplete) {
      return;
    }

    if (!routeThreadExists && environmentHasAnyThreads) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasAnyThreads, navigate, routeThreadExists, threadRef]);

  useEffect(() => {
    if (!threadRef || !serverThreadStarted || !draftThread?.promotedTo) {
      return;
    }
    finalizePromotedDraftThreadByRef(threadRef);
  }, [draftThread?.promotedTo, serverThreadStarted, threadRef]);

  if (!threadRef || !bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const shouldRenderDiffContent = hasOpenedDiffTab || (rightPanelOpen && rightPanelTab === "diff");
  const filesContent = (
    <ProjectFilesPanel
      environmentId={threadRef.environmentId}
      cwd={serverThread?.worktreePath ?? draftThread?.worktreePath ?? project?.cwd ?? null}
      visible={rightPanelOpen && rightPanelTab === "files"}
      resolvedTheme={resolvedTheme}
    />
  );
  const diffContent = shouldRenderDiffContent ? <LazyDiffPanel mode="embedded" /> : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ChatSplitView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
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

export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
