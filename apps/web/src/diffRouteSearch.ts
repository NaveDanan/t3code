import { TurnId } from "@t3tools/contracts";

export type RightPanelTab = "diff" | "files";

const RIGHT_PANEL_TAB_STORAGE_KEY = "chat_right_panel_tab";
const DEFAULT_RIGHT_PANEL_TAB: RightPanelTab = "files";

export function getStoredRightPanelTab(): RightPanelTab {
  try {
    const stored = localStorage.getItem(RIGHT_PANEL_TAB_STORAGE_KEY);
    if (stored === "diff" || stored === "files") return stored;
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_RIGHT_PANEL_TAB;
}

export function saveRightPanelTab(tab: RightPanelTab): void {
  try {
    localStorage.setItem(RIGHT_PANEL_TAB_STORAGE_KEY, tab);
  } catch {
    // localStorage unavailable
  }
}

export interface DiffRouteSearch {
  rightPanel?: "1" | undefined;
  rightPanelTab?: RightPanelTab | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diffTurnId" | "diffFilePath"> {
  const { diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diffTurnId" | "diffFilePath">;
}

export function stripFilesSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "files"> {
  const { files: _files, ...rest } = params;
  return rest as Omit<T, "files">;
}

export function stripRightPanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "rightPanel" | "rightPanelTab"> {
  const { rightPanel: _rightPanel, rightPanelTab: _rightPanelTab, ...rest } = params;
  return rest as Omit<T, "rightPanel" | "rightPanelTab">;
}

export function updateRightPanelSearch<T extends Record<string, unknown>>(input: {
  previous: T;
  open: boolean;
  tab?: RightPanelTab;
  fallbackTab?: RightPanelTab;
}): T | Omit<T, "rightPanel" | "rightPanelTab"> {
  const currentOpen = isDiffOpenValue(input.previous.rightPanel);
  const currentTabRaw = normalizeSearchString(input.previous.rightPanelTab);
  const currentTab =
    currentTabRaw === "diff" || currentTabRaw === "files" ? currentTabRaw : undefined;

  if (!input.open) {
    if (!("rightPanel" in input.previous) && !("rightPanelTab" in input.previous)) {
      return input.previous;
    }
    return stripRightPanelSearchParams(input.previous);
  }

  const nextTab = input.tab ?? currentTab ?? input.fallbackTab ?? DEFAULT_RIGHT_PANEL_TAB;
  if (currentOpen && currentTab === nextTab) {
    return input.previous;
  }

  return {
    ...input.previous,
    rightPanel: "1",
    rightPanelTab: nextTab,
  };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const rightPanel = isDiffOpenValue(search.rightPanel) ? "1" : undefined;
  const rightPanelTabRaw = normalizeSearchString(search.rightPanelTab);
  const rightPanelTab =
    rightPanelTabRaw === "diff" || rightPanelTabRaw === "files" ? rightPanelTabRaw : undefined;
  const diffTurnIdRaw = normalizeSearchString(search.diffTurnId);
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;

  return {
    ...(rightPanel ? { rightPanel } : {}),
    ...(rightPanelTab ? { rightPanelTab } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}
