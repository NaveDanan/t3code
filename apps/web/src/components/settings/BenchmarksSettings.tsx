import {
  type EnvironmentId,
  type ProviderKind,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ChevronsUpDownIcon,
  GaugeIcon,
  GitBranchIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Link } from "@tanstack/react-router";

import { type BenchmarkLaneConfig, type BenchmarkLaneRun } from "../../benchmarks/benchmarkRun";
import {
  applyBenchmarkDispatchResults,
  buildBenchmarkRun,
  canRunBenchmarkDraft,
  dispatchBenchmarkCommands,
  MAX_BENCHMARK_LANES,
  validateBenchmarkRunDraft,
} from "../../benchmarks/benchmarkRun";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import ChatView from "../ChatView";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { ensureEnvironmentApi } from "../../environmentApi";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useSettings } from "../../hooks/useSettings";
import { gitBranchSearchInfiniteQueryOptions } from "../../lib/gitReactQuery";
import { useGitStatus } from "../../lib/gitStatusState";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import { useServerConfig } from "../../rpc/serverState";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { PROVIDER_OPTIONS } from "../../session-logic";
import type { Project } from "../../types";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { cn } from "~/lib/utils";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type BenchmarkProjectOption = {
  id: Project["id"];
  environmentId: EnvironmentId;
  cwd: string;
  name: string;
  environmentLabel: string;
  defaultModelSelection: Project["defaultModelSelection"];
};

type BenchmarkLaneShellProps = {
  project: BenchmarkProjectOption;
  lane: BenchmarkLaneRun;
};

type BenchmarkBaseBranchSelectorProps = {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  value: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
};

type BenchmarkProviderChoice = {
  provider: ProviderKind;
  label: string;
  selectable: boolean;
};

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

const DEFAULT_BENCHMARK_LANES: BenchmarkLaneConfig[] = [
  { id: "lane-1", provider: "codex", model: "gpt-5.4" },
  { id: "lane-2", provider: "claudeAgent", model: "claude-sonnet-4-6" },
];

const PROVIDER_LABELS = new Map(
  PROVIDER_OPTIONS.filter((option) => option.available).map((option) => [
    option.value,
    option.label,
  ]),
);

function providerLabel(provider: ProviderKind): string {
  return PROVIDER_LABELS.get(provider) ?? provider;
}

function nextLaneId(current: ReadonlyArray<BenchmarkLaneConfig>): string {
  const highest = current.reduce((max, lane) => {
    const match = /^lane-(\d+)$/.exec(lane.id);
    return match ? Math.max(max, Number.parseInt(match[1]!, 10)) : max;
  }, 0);
  return `lane-${highest + 1}`;
}

function resolveProjectServerConfig(input: {
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
  primaryServerConfig: ServerConfig | null;
  runtimeServerConfig: ServerConfig | null | undefined;
}): ServerConfig | null {
  if (input.primaryEnvironmentId && input.environmentId === input.primaryEnvironmentId) {
    return input.primaryServerConfig;
  }
  return input.runtimeServerConfig ?? input.primaryServerConfig;
}

function modelLabel(input: {
  provider: ProviderKind;
  model: string;
  modelOptionsByProvider: ReturnType<typeof getCustomModelOptionsByProvider>;
}): string {
  return (
    input.modelOptionsByProvider[input.provider].find((option) => option.slug === input.model)
      ?.name ?? input.model
  );
}

function resolveBenchmarkProviderChoices(
  providers: ReadonlyArray<ServerProvider>,
): BenchmarkProviderChoice[] {
  const providerByKind = new Map(
    providers.map((provider) => [provider.provider, provider] as const),
  );
  return PROVIDER_OPTIONS.filter(
    (
      option,
    ): option is (typeof PROVIDER_OPTIONS)[number] & { available: true; value: ProviderKind } =>
      option.available && option.value !== "cursor",
  ).flatMap((option) => {
    const provider = providerByKind.get(option.value);
    if (!provider) {
      return [];
    }
    return [
      {
        provider: option.value,
        label: option.label,
        selectable: provider.enabled && provider.status === "ready",
      } satisfies BenchmarkProviderChoice,
    ];
  });
}

function pickNextBenchmarkProvider(
  lanes: ReadonlyArray<BenchmarkLaneConfig>,
  providerChoices: ReadonlyArray<BenchmarkProviderChoice>,
): ProviderKind | null {
  const usedProviders = new Set(lanes.map((lane) => lane.provider));
  return (
    providerChoices.find((choice) => choice.selectable && !usedProviders.has(choice.provider))
      ?.provider ?? null
  );
}

function BenchmarkBaseBranchSelector({
  environmentId,
  cwd,
  value,
  disabled = false,
  onValueChange,
}: BenchmarkBaseBranchSelectorProps) {
  const [open, setOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);
  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);

  const {
    data: branchSearchData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
  } = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      environmentId,
      cwd,
      query: deferredBranchQuery,
    }),
  );

  const branches = useMemo(
    () => branchSearchData?.pages.flatMap((page) => page.branches) ?? [],
    [branchSearchData?.pages],
  );
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
  const totalBranchCount = branchSearchData?.pages[0]?.totalCount ?? branchNames.length;
  const branchStatusText = isPending
    ? "Loading branches..."
    : isFetchingNextPage
      ? "Loading more branches..."
      : hasNextPage
        ? `Showing ${branches.length} of ${totalBranchCount} branches`
        : null;

  const maybeFetchNextPage = useCallback(() => {
    if (!open || !hasNextPage || isFetchingNextPage) {
      return;
    }

    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const distanceFromBottom =
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    if (distanceFromBottom > 96) {
      return;
    }

    void fetchNextPage().catch(() => undefined);
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, open]);

  const setBranchListRef = useCallback((element: HTMLDivElement | null) => {
    branchListScrollElementRef.current = (element?.parentElement as HTMLDivElement | null) ?? null;
  }, []);

  useEffect(() => {
    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement || !open) {
      return;
    }

    const handleScroll = () => {
      maybeFetchNextPage();
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [maybeFetchNextPage, open]);

  useEffect(() => {
    maybeFetchNextPage();
  }, [branches.length, maybeFetchNextPage]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setBranchQuery("");
    }
  }, []);

  return (
    <Combobox
      items={branchNames}
      filteredItems={branchNames}
      open={open}
      onOpenChange={handleOpenChange}
      value={value || null}
    >
      <ComboboxTrigger
        render={
          <Button
            aria-label="Base branch"
            data-testid="benchmark-base-branch-trigger"
            variant="outline"
            className="w-full justify-between"
            disabled={disabled || !environmentId || !cwd}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <GitBranchIcon className="size-4 text-muted-foreground" />
          <span className="truncate text-left">{value || "Select branch"}</span>
        </span>
        <ChevronsUpDownIcon className="size-4 text-muted-foreground/70" />
      </ComboboxTrigger>
      <ComboboxPopup className="w-[min(32rem,calc(100vw-2rem))]">
        <div className="border-b p-1">
          <ComboboxInput
            placeholder="Search branches..."
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No branches found.</ComboboxEmpty>
        <ComboboxList ref={setBranchListRef} className="max-h-72">
          {branchNames.map((branchName, index) => {
            const branch = branchByName.get(branchName);
            const badge = branch?.current
              ? "current"
              : branch?.isDefault
                ? "default"
                : branch?.worktreePath
                  ? "worktree"
                  : null;
            return (
              <ComboboxItem
                key={branchName}
                hideIndicator
                index={index}
                value={branchName}
                onClick={() => {
                  onValueChange(branchName);
                  setOpen(false);
                }}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="truncate">{branchName}</span>
                  {badge ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">{badge}</span>
                  ) : null}
                </div>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
        {branchStatusText ? <ComboboxStatus>{branchStatusText}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}

function BenchmarkLaneShell({ project, lane }: BenchmarkLaneShellProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(project.environmentId, lane.threadId),
    [lane.threadId, project.environmentId],
  );
  const thread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));

  return (
    <section className="flex min-h-[42rem] min-w-0 flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm/5">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {providerLabel(lane.provider)} · {lane.model}
            </h3>
            <p className="text-xs text-muted-foreground">
              {lane.dispatchStatus === "pending"
                ? "Ready to launch"
                : lane.dispatchStatus === "dispatched"
                  ? "Dispatched"
                  : "Dispatch failed"}
            </p>
            <p className="break-all text-[11px] text-muted-foreground/80">Thread {lane.threadId}</p>
          </div>
          <Button
            size="xs"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: project.environmentId,
                  threadId: lane.threadId,
                }}
              />
            }
          >
            Open full chat
          </Button>
        </div>
        {lane.error ? (
          <p className="mt-2 text-xs text-destructive" role="status">
            {lane.error}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {lane.dispatchStatus === "failed" ? (
          <Empty className="min-h-full gap-3 p-6">
            <EmptyHeader>
              <EmptyTitle className="text-base">Lane failed before startup</EmptyTitle>
              <EmptyDescription>
                This lane kept its shell so you can compare it against the successful runs.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : thread ? (
          <ChatView
            environmentId={project.environmentId}
            threadId={lane.threadId}
            routeKind="server"
            presentation="benchmarkLane"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            <Spinner className="mr-2 size-4" /> Waiting for thread startup...
          </div>
        )}
      </div>
    </section>
  );
}

export const BenchmarksSettings = memo(function BenchmarksSettings() {
  const settings = useSettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerConfig = useServerConfig();
  const runtimeStateById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  const projectOptions = useMemo<BenchmarkProjectOption[]>(() => {
    return projects
      .map((project) => ({
        id: project.id,
        environmentId: project.environmentId,
        cwd: project.cwd,
        name: project.name,
        defaultModelSelection: project.defaultModelSelection,
        environmentLabel: resolveEnvironmentOptionLabel({
          isPrimary: project.environmentId === primaryEnvironmentId,
          environmentId: project.environmentId,
          runtimeLabel: runtimeStateById[project.environmentId]?.descriptor?.label ?? null,
          savedLabel: savedEnvironmentRegistry[project.environmentId]?.label ?? null,
        }),
      }))
      .toSorted(
        (left, right) =>
          left.environmentLabel.localeCompare(right.environmentLabel) ||
          left.name.localeCompare(right.name),
      );
  }, [primaryEnvironmentId, projects, runtimeStateById, savedEnvironmentRegistry]);

  const [projectId, setProjectId] = useState<Project["id"] | null>(projectOptions[0]?.id ?? null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [lanes, setLanes] = useState<BenchmarkLaneConfig[]>(DEFAULT_BENCHMARK_LANES);
  const [runLanes, setRunLanes] = useState<BenchmarkLaneRun[]>([]);
  const [runProject, setRunProject] = useState<BenchmarkProjectOption | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [setupPaneCollapsed, setSetupPaneCollapsed] = useState(false);

  useEffect(() => {
    if (projectOptions.length === 0) {
      if (projectId !== null) {
        setProjectId(null);
      }
      return;
    }

    if (!projectId || !projectOptions.some((project) => project.id === projectId)) {
      setProjectId(projectOptions[0]!.id);
    }
  }, [projectId, projectOptions]);

  const deferredProjectQuery = useDeferredValue(projectQuery);
  const filteredProjectOptions = useMemo(() => {
    const normalizedQuery = deferredProjectQuery.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return projectOptions;
    }

    return projectOptions.filter((project) => {
      const searchableText =
        `${project.environmentLabel}\n${project.name}\n${project.cwd}`.toLowerCase();
      return searchableText.includes(normalizedQuery);
    });
  }, [deferredProjectQuery, projectOptions]);

  const selectedProject = useMemo(
    () => projectOptions.find((project) => project.id === projectId) ?? null,
    [projectId, projectOptions],
  );
  const projectServerConfig = useMemo(() => {
    if (!selectedProject) {
      return null;
    }

    return resolveProjectServerConfig({
      environmentId: selectedProject.environmentId,
      primaryEnvironmentId,
      primaryServerConfig,
      runtimeServerConfig: runtimeStateById[selectedProject.environmentId]?.serverConfig,
    });
  }, [primaryEnvironmentId, primaryServerConfig, runtimeStateById, selectedProject]);
  const providers = projectServerConfig?.providers ?? EMPTY_PROVIDERS;
  const providerChoices = useMemo(() => resolveBenchmarkProviderChoices(providers), [providers]);
  const modelOptionsByProvider = useMemo(
    () => getCustomModelOptionsByProvider(settings, providers),
    [providers, settings],
  );
  const draft = useMemo(
    () =>
      selectedProject
        ? {
            environmentId: selectedProject.environmentId,
            projectId: selectedProject.id,
            projectCwd: selectedProject.cwd,
            baseBranch,
            prompt,
            runtimeMode: "full-access" as const,
            lanes,
          }
        : null,
    [baseBranch, lanes, prompt, selectedProject],
  );
  const validation = useMemo(
    () =>
      draft && selectedProject
        ? validateBenchmarkRunDraft(draft, {
            project: {
              id: selectedProject.id,
              cwd: selectedProject.cwd,
              defaultModelSelection: selectedProject.defaultModelSelection,
            },
            providers,
            settings,
          })
        : null,
    [draft, providers, selectedProject, settings],
  );
  const gitStatus = useGitStatus({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.cwd ?? null,
  });

  const canRun = Boolean(
    draft &&
    selectedProject &&
    canRunBenchmarkDraft({
      draft,
      context: {
        project: {
          id: selectedProject.id,
          cwd: selectedProject.cwd,
          defaultModelSelection: selectedProject.defaultModelSelection,
        },
        providers,
        settings,
      },
      gitStatus: gitStatus.data,
    }) &&
    !isLaunching,
  );

  const projectItems = useMemo(() => projectOptions.map((project) => project.id), [projectOptions]);
  const visibleProjectItems = useMemo(
    () => filteredProjectOptions.map((project) => project.id),
    [filteredProjectOptions],
  );
  const canAddLane = useMemo(
    () =>
      lanes.length < MAX_BENCHMARK_LANES &&
      pickNextBenchmarkProvider(lanes, providerChoices) !== null,
    [lanes, providerChoices],
  );
  const activeRunProject = runProject ?? selectedProject;

  const updateLane = useCallback((laneId: string, patch: Partial<BenchmarkLaneConfig>) => {
    setLanes((current) =>
      current.map((lane) => {
        if (lane.id !== laneId) {
          return lane;
        }
        return {
          ...lane,
          ...patch,
        };
      }),
    );
  }, []);

  const addLane = useCallback(() => {
    setLanes((current) => {
      if (current.length >= MAX_BENCHMARK_LANES) {
        return current;
      }
      const nextProvider = pickNextBenchmarkProvider(current, providerChoices);
      if (!nextProvider) {
        return current;
      }
      return [
        ...current,
        {
          id: nextLaneId(current),
          provider: nextProvider,
          model: modelOptionsByProvider[nextProvider][0]?.slug ?? "",
        },
      ];
    });
  }, [modelOptionsByProvider, providerChoices]);

  const removeLane = useCallback((laneId: string) => {
    setLanes((current) => current.filter((lane) => lane.id !== laneId));
  }, []);

  const launch = useCallback(async () => {
    if (!draft || !selectedProject) {
      return;
    }

    const project = selectedProject;

    const api = ensureEnvironmentApi(selectedProject.environmentId);
    setIsLaunching(true);
    setRunError(null);

    try {
      const run = buildBenchmarkRun(draft, {
        project: {
          id: project.id,
          cwd: project.cwd,
          defaultModelSelection: project.defaultModelSelection,
        },
        providers,
        settings,
      });
      setRunProject(project);
      setRunLanes(
        applyBenchmarkDispatchResults({
          lanes: run.lanes,
          results: [],
        }),
      );
      const results = await dispatchBenchmarkCommands({
        run,
        dispatch: async (command) => {
          await api.orchestration.dispatchCommand(command);
        },
      });
      setRunLanes(
        applyBenchmarkDispatchResults({
          lanes: run.lanes,
          results,
        }),
      );
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Failed to start benchmark run.");
    } finally {
      setIsLaunching(false);
    }
  }, [draft, providers, selectedProject, settings]);

  const handleProjectPickerOpenChange = useCallback((open: boolean) => {
    setProjectPickerOpen(open);
    if (!open) {
      setProjectQuery("");
    }
  }, []);

  return (
    <SettingsPageContainer size="wide">
      <SettingsSection
        title="Benchmarks"
        icon={<GaugeIcon className="size-3.5" />}
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            aria-controls="benchmark-setup-pane"
            aria-expanded={!setupPaneCollapsed}
            aria-label={setupPaneCollapsed ? "Expand setup pane" : "Collapse setup pane"}
            onClick={() => setSetupPaneCollapsed((collapsed) => !collapsed)}
          >
            {setupPaneCollapsed ? (
              <PanelLeftOpenIcon className="size-3.5" />
            ) : (
              <PanelLeftCloseIcon className="size-3.5" />
            )}
            {setupPaneCollapsed ? "Expand setup pane" : "Collapse setup pane"}
          </Button>
        }
      >
        <div
          className={cn(
            "grid gap-5 p-4 sm:p-5",
            setupPaneCollapsed ? "grid-cols-1" : "xl:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]",
          )}
        >
          <div id="benchmark-setup-pane" hidden={setupPaneCollapsed} className="space-y-5">
            <div className="space-y-2">
              <Label>Project</Label>
              <Combobox
                items={projectItems}
                filteredItems={visibleProjectItems}
                open={projectPickerOpen}
                onOpenChange={handleProjectPickerOpenChange}
                value={selectedProject?.id ?? null}
              >
                <ComboboxTrigger
                  render={
                    <Button
                      aria-label="Project"
                      variant="outline"
                      className="w-full justify-between"
                    />
                  }
                >
                  <span className="truncate text-left">
                    {selectedProject
                      ? `${selectedProject.environmentLabel} · ${selectedProject.name}`
                      : projectOptions.length === 0
                        ? "No projects available"
                        : "Select project"}
                  </span>
                  <ChevronsUpDownIcon className="size-4 text-muted-foreground/70" />
                </ComboboxTrigger>
                <ComboboxPopup className="w-[min(32rem,calc(100vw-2rem))]">
                  <div className="border-b p-1">
                    <ComboboxInput
                      placeholder="Search projects..."
                      showTrigger={false}
                      size="sm"
                      value={projectQuery}
                      onChange={(event) => setProjectQuery(event.target.value)}
                    />
                  </div>
                  <ComboboxEmpty>No projects found.</ComboboxEmpty>
                  <ComboboxList className="max-h-72">
                    {filteredProjectOptions.map((project) => (
                      <ComboboxItem
                        key={project.id}
                        value={project.id}
                        onClick={() => {
                          setProjectId(project.id);
                          setProjectPickerOpen(false);
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-foreground">
                              {project.name}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {project.environmentLabel} · {project.cwd}
                            </div>
                          </div>
                        </div>
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </div>

            <div className="space-y-2">
              <Label>Base branch</Label>
              <BenchmarkBaseBranchSelector
                environmentId={selectedProject?.environmentId ?? null}
                cwd={selectedProject?.cwd ?? null}
                value={baseBranch}
                onValueChange={setBaseBranch}
                disabled={!selectedProject}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="benchmark-prompt">Prompt</Label>
              <Textarea
                id="benchmark-prompt"
                rows={8}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Enter the exact prompt every lane should receive."
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>Benchmark lanes</Label>
                  <p className="text-xs text-muted-foreground">
                    Use 2-6 distinct providers. Each lane gets its own fresh worktree.
                  </p>
                </div>
                <Button size="xs" variant="outline" onClick={addLane} disabled={!canAddLane}>
                  <PlusIcon className="size-3.5" /> Add lane
                </Button>
              </div>

              <div className="space-y-3">
                {lanes.map((lane, index) => (
                  <div key={lane.id} className="rounded-xl border border-border/60 p-3">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">Lane {index + 1}</p>
                        <p className="text-xs text-muted-foreground">Provider and model</p>
                      </div>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove lane ${index + 1}`}
                        onClick={() => removeLane(lane.id)}
                        disabled={lanes.length <= 1}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
                      <Select
                        value={lane.provider}
                        onValueChange={(value) => {
                          const provider = value as ProviderKind;
                          updateLane(lane.id, {
                            provider,
                            model: modelOptionsByProvider[provider][0]?.slug ?? "",
                          });
                        }}
                      >
                        <SelectTrigger aria-label={`Lane ${index + 1} provider`}>
                          <SelectValue>{providerLabel(lane.provider)}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {providerChoices.map((provider) => (
                            <SelectItem
                              key={provider.provider}
                              value={provider.provider}
                              hideIndicator
                              disabled={!provider.selectable}
                            >
                              {provider.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>

                      <ProviderModelPicker
                        provider={lane.provider}
                        model={lane.model || modelOptionsByProvider[lane.provider][0]?.slug || ""}
                        lockedProvider={lane.provider}
                        providers={providers}
                        modelOptionsByProvider={modelOptionsByProvider}
                        triggerVariant="outline"
                        triggerClassName="w-full max-w-none justify-between px-3 text-foreground"
                        onProviderModelChange={(_provider, model) => {
                          updateLane(lane.id, { model });
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {modelLabel({
                          provider: lane.provider,
                          model: lane.model || modelOptionsByProvider[lane.provider][0]?.slug || "",
                          modelOptionsByProvider,
                        })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {validation && !validation.ok ? (
              <Alert variant="warning">
                <GaugeIcon className="size-4" />
                <AlertTitle>Benchmark draft needs fixes</AlertTitle>
                <AlertDescription>
                  {validation.errors.map((error) => (
                    <div key={error}>{error}</div>
                  ))}
                </AlertDescription>
              </Alert>
            ) : null}

            {runError ? (
              <Alert variant="error">
                <GaugeIcon className="size-4" />
                <AlertTitle>Benchmark launch failed</AlertTitle>
                <AlertDescription>{runError}</AlertDescription>
              </Alert>
            ) : null}

            <SettingsRow
              title="Run benchmark"
              description="Launch one persisted thread per lane from the selected base branch."
              status={
                !selectedProject
                  ? "Select a project to configure a benchmark run."
                  : gitStatus.data?.isRepo === false
                    ? "This project is not a Git repository."
                    : gitStatus.isPending
                      ? "Checking repository status..."
                      : undefined
              }
              control={
                <Button onClick={() => void launch()} disabled={!canRun}>
                  <PlayIcon className="size-4" />
                  {isLaunching ? "Launching..." : "Run"}
                </Button>
              }
            />
          </div>

          <div className="min-w-0">
            {runLanes.length === 0 || !activeRunProject ? (
              <Empty className="min-h-[42rem] rounded-2xl border border-dashed bg-muted/15">
                <EmptyMedia variant="icon">
                  <GaugeIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Benchmark lanes will appear here</EmptyTitle>
                  <EmptyDescription>
                    Run a benchmark to open one embedded chat lane per provider.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div
                className={cn(
                  "grid gap-4",
                  runLanes.length === 2
                    ? "lg:grid-cols-2"
                    : "grid-cols-1 overflow-x-auto md:auto-cols-[minmax(360px,1fr)] md:grid-flow-col",
                )}
              >
                {runLanes.map((lane) => (
                  <BenchmarkLaneShell key={lane.laneId} project={activeRunProject} lane={lane} />
                ))}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
});
