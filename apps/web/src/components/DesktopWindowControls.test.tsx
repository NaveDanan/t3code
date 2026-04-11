import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopWindowControls } from "./DesktopWindowControls";

function setDesktopBridge(value: unknown) {
  vi.stubGlobal("window", {
    desktopBridge: value,
  });
}

describe("DesktopWindowControls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not render controls when desktop bridge APIs are unavailable", () => {
    setDesktopBridge(undefined);
    const html = renderToStaticMarkup(<DesktopWindowControls />);

    expect(html).toBe("");
  });

  it("renders controls when desktop bridge APIs are available", () => {
    setDesktopBridge({
      minimizeWindow: async () => undefined,
      toggleMaximizeWindow: async () => ({ maximized: false }),
      closeWindow: async () => undefined,
      getWindowState: async () => ({ maximized: false }),
      onWindowState: () => () => undefined,
    });
    const html = renderToStaticMarkup(<DesktopWindowControls />);

    expect(html).toContain("Minimize window");
    expect(html).toContain("Maximize window");
    expect(html).toContain("Close window");
  });
});
