import type { DesktopWindowState } from "@t3tools/contracts";
import { Maximize2Icon, MinusIcon, Minimize2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

function canControlDesktopWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.desktopBridge?.minimizeWindow === "function" &&
    typeof window.desktopBridge?.toggleMaximizeWindow === "function" &&
    typeof window.desktopBridge?.closeWindow === "function"
  );
}

export function DesktopWindowControls(props: { className?: string }) {
  const [windowState, setWindowState] = useState<DesktopWindowState>({ maximized: false });
  const available = canControlDesktopWindow();

  useEffect(() => {
    if (!available) {
      return;
    }

    const bridge = window.desktopBridge;
    if (!bridge) {
      return;
    }

    let disposed = false;

    void bridge
      .getWindowState()
      .then((nextState) => {
        if (!disposed) {
          setWindowState(nextState);
        }
      })
      .catch(() => undefined);

    const unsubscribe = bridge.onWindowState((nextState) => {
      if (!disposed) {
        setWindowState(nextState);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [available]);

  if (!available) {
    return null;
  }

  return (
    <div className={cn("flex items-stretch gap-0.5 [-webkit-app-region:no-drag]", props.className)}>
      <button
        type="button"
        aria-label="Minimize window"
        className="inline-flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => {
          void window.desktopBridge?.minimizeWindow();
        }}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={windowState.maximized ? "Restore window" : "Maximize window"}
        className="inline-flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => {
          void window.desktopBridge
            ?.toggleMaximizeWindow()
            .then((nextState) => {
              setWindowState(nextState);
            })
            .catch(() => undefined);
        }}
      >
        {windowState.maximized ? (
          <Minimize2Icon className="size-3.5" />
        ) : (
          <Maximize2Icon className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        aria-label="Close window"
        className="inline-flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/90 hover:text-white"
        onClick={() => {
          void window.desktopBridge?.closeWindow();
        }}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
