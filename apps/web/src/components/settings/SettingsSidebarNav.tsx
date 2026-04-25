import type { ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GaugeIcon,
  Link2Icon,
  Settings2Icon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useBenchmarkHistoryStore } from "../../benchmarks/benchmarkHistoryStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
} from "../ui/sidebar";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/connections"
  | "/settings/benchmarks"
  | "/settings/archived";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Connections", to: "/settings/connections", icon: Link2Icon },
  { label: "Benchmarks", to: "/settings/benchmarks", icon: GaugeIcon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const benchmarkRunId = useLocation({
    select: (location) => {
      const runId = (location.search as { runId?: unknown }).runId;
      return typeof runId === "string" && runId.length > 0 ? runId : null;
    },
  });
  const benchmarkRuns = useBenchmarkHistoryStore((state) => state.runs);
  const [benchmarksExpanded, setBenchmarksExpanded] = useState(true);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.to;
              const isBenchmarks = item.to === "/settings/benchmarks";
              return (
                <SidebarMenuItem key={item.to} className="relative">
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActive}
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 pr-8 text-left text-[13px] font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 pr-8 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                    }
                    onClick={() => {
                      if (isBenchmarks) {
                        void navigate({ to: item.to, search: {}, replace: true });
                        return;
                      }
                      void navigate({ to: item.to, replace: true });
                    }}
                  >
                    <Icon
                      className={
                        isActive
                          ? "size-4 shrink-0 text-foreground"
                          : "size-4 shrink-0 text-muted-foreground/60"
                      }
                    />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                  {isBenchmarks ? (
                    <>
                      <SidebarMenuAction
                        aria-label={
                          benchmarksExpanded
                            ? "Collapse benchmark history"
                            : "Expand benchmark history"
                        }
                        className="top-1.5 right-1"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setBenchmarksExpanded((expanded) => !expanded);
                        }}
                      >
                        {benchmarksExpanded ? (
                          <ChevronDownIcon className="size-3.5" />
                        ) : (
                          <ChevronRightIcon className="size-3.5" />
                        )}
                      </SidebarMenuAction>
                      {benchmarksExpanded ? (
                        <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-1">
                          {benchmarkRuns.length === 0 ? (
                            <SidebarMenuSubItem className="w-full">
                              <div className="flex h-6 w-full items-center px-2 text-left text-[10px] text-muted-foreground/60">
                                <span>No benchmark history</span>
                              </div>
                            </SidebarMenuSubItem>
                          ) : (
                            benchmarkRuns.map((run) => (
                              <SidebarMenuSubItem key={run.id} className="w-full">
                                <SidebarMenuSubButton
                                  render={<button type="button" />}
                                  size="sm"
                                  isActive={benchmarkRunId === run.id}
                                  className="h-7 w-full justify-start gap-2 px-2 text-left text-xs"
                                  onClick={() => {
                                    void navigate({
                                      to: "/settings/benchmarks",
                                      search: { runId: run.id },
                                      replace: true,
                                    });
                                  }}
                                >
                                  <span className="min-w-0 flex-1 truncate">{run.title}</span>
                                  <span className="shrink-0 text-[10px] text-muted-foreground/45">
                                    {formatRelativeTimeLabel(run.updatedAt)}
                                  </span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))
                          )}
                        </SidebarMenuSub>
                      ) : null}
                    </>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => window.history.back()}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
