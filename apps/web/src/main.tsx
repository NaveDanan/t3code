import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { applyAppFontSize, readStoredAppFontSize } from "./appFontSize";

const shouldUseHashHistory =
  isElectron ||
  (typeof window !== "undefined" &&
    window.location.protocol !== "http:" &&
    window.location.protocol !== "https:");

// Packaged desktop builds load from the custom t3:// shell, so hash history
// keeps route resolution stable even if the preload bridge fails to initialize.
const history = shouldUseHashHistory ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

applyAppFontSize(readStoredAppFontSize());

document.title = APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
