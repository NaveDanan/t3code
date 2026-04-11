import { DEFAULT_APP_FONT_SIZE, type AppFontSize } from "@t3tools/contracts/settings";

import { CLIENT_SETTINGS_STORAGE_KEY } from "./clientSettings";

export const APP_FONT_SIZE_OPTIONS: ReadonlyArray<{
  value: AppFontSize;
  label: string;
  offsetLabel: string;
}> = [
  {
    value: "normal",
    label: "Normal",
    offsetLabel: "Default",
  },
  {
    value: "big",
    label: "Big",
    offsetLabel: "+2 px",
  },
  {
    value: "large",
    label: "Large",
    offsetLabel: "+4 px",
  },
  {
    value: "xlarge",
    label: "XLarge",
    offsetLabel: "+6 px",
  },
];

export function isAppFontSize(value: unknown): value is AppFontSize {
  return APP_FONT_SIZE_OPTIONS.some((option) => option.value === value);
}

export function applyAppFontSize(appFontSize: AppFontSize): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.appFontSize = appFontSize;
}

export function readStoredAppFontSize(): AppFontSize {
  if (typeof window === "undefined") {
    return DEFAULT_APP_FONT_SIZE;
  }

  try {
    const raw = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_APP_FONT_SIZE;
    }

    const parsed = JSON.parse(raw) as { appFontSize?: unknown };
    return isAppFontSize(parsed.appFontSize) ? parsed.appFontSize : DEFAULT_APP_FONT_SIZE;
  } catch {
    return DEFAULT_APP_FONT_SIZE;
  }
}
