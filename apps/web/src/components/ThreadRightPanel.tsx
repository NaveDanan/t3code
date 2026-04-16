import * as Schema from "effect/Schema";
import { DiffIcon, FilesIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { RightPanelTab } from "~/diffRouteSearch";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

import { Sheet, SheetPopup } from "./ui/sheet";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

const RIGHT_PANEL_STORAGE_KEY = "chat_right_panel_width";
const RIGHT_PANEL_MIN_WIDTH = 22 * 16;

function RightPanelTabs(props: {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
}) {
  const selectedTabs = useMemo(() => [props.activeTab], [props.activeTab]);

  return (
    <div className="border-b border-border px-3 py-2">
      <ToggleGroup
        variant="outline"
        size="sm"
        value={selectedTabs}
        onValueChange={(value) => {
          const next = value[0];
          if ((next === "diff" || next === "files") && next !== props.activeTab) {
            props.onTabChange(next);
          }
        }}
      >
        <Toggle value="diff" aria-label="Show diffs panel">
          <DiffIcon className="size-3.5" />
          Diffs
        </Toggle>
        <Toggle value="files" aria-label="Show files panel">
          <FilesIcon className="size-3.5" />
          Files
        </Toggle>
      </ToggleGroup>
    </div>
  );
}

function RightPanelBody(props: {
  activeTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  diffContent: ReactNode;
  filesContent: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-card text-foreground">
      <RightPanelTabs activeTab={props.activeTab} onTabChange={props.onTabChange} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {props.activeTab === "diff" ? props.diffContent : props.filesContent}
      </div>
    </div>
  );
}

export function ThreadRightPanelInlineSidebar(props: {
  open: boolean;
  activeTab: RightPanelTab;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: RightPanelTab) => void;
  diffContent: ReactNode;
  filesContent: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{
    startX: number;
    startWidth: number;
    width: number;
    pendingWidth: number;
    pointerId: number;
    rafId: number | null;
  } | null>(null);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const stored = getLocalStorageItem(RIGHT_PANEL_STORAGE_KEY, Schema.Finite);
    if (stored !== null && stored >= RIGHT_PANEL_MIN_WIDTH) return stored;
    return 26 * 16; // 416px default
  });
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const onRailPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !containerRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startWidth = panelWidthRef.current;
    containerRef.current.style.setProperty("transition-duration", "0ms");
    resizeStateRef.current = {
      startX: e.clientX,
      startWidth,
      width: startWidth,
      pendingWidth: startWidth,
      pointerId: e.pointerId,
      rafId: null,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onRailPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== e.pointerId || !containerRef.current) return;
    e.preventDefault();
    // Dragging the left rail leftward grows the panel
    state.pendingWidth = Math.max(
      RIGHT_PANEL_MIN_WIDTH,
      state.startWidth + (state.startX - e.clientX),
    );
    if (state.rafId !== null) return;
    state.rafId = window.requestAnimationFrame(() => {
      const s = resizeStateRef.current;
      if (!s || !containerRef.current) return;
      s.rafId = null;
      s.width = s.pendingWidth;
      containerRef.current.style.setProperty("--rp-width", `${s.width}px`);
    });
  }, []);

  const onRailPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    if (state.rafId !== null) window.cancelAnimationFrame(state.rafId);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    containerRef.current?.style.removeProperty("transition-duration");
    const finalWidth = state.width;
    resizeStateRef.current = null;
    setLocalStorageItem(RIGHT_PANEL_STORAGE_KEY, finalWidth, Schema.Finite);
    setPanelWidth(finalWidth);
    panelWidthRef.current = finalWidth;
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative flex-none overflow-hidden transition-[width] duration-200"
      style={
        {
          width: props.open ? "var(--rp-width)" : 0,
          "--rp-width": `${panelWidth}px`,
        } as CSSProperties
      }
    >
      {/* Fixed-width inner so content doesn't re-layout during the open/close transition */}
      <div className="h-full" style={{ width: "var(--rp-width)" }}>
        <RightPanelBody
          activeTab={props.activeTab}
          onTabChange={props.onTabChange}
          diffContent={props.diffContent}
          filesContent={props.filesContent}
        />
      </div>
      {/* Resize rail on the left edge */}
      {props.open && (
        <div
          className="absolute inset-y-0 left-0 z-20 w-4 cursor-col-resize"
          onPointerDown={onRailPointerDown}
          onPointerMove={onRailPointerMove}
          onPointerUp={onRailPointerUp}
          onPointerCancel={onRailPointerUp}
        />
      )}
    </div>
  );
}

export function ThreadRightPanelSheet(props: {
  open: boolean;
  activeTab: RightPanelTab;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: RightPanelTab) => void;
  diffContent: ReactNode;
  filesContent: ReactNode;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        <RightPanelBody
          activeTab={props.activeTab}
          onTabChange={props.onTabChange}
          diffContent={props.diffContent}
          filesContent={props.filesContent}
        />
      </SheetPopup>
    </Sheet>
  );
}

export type { RightPanelTab };
