/// <reference types="vite/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }
}
