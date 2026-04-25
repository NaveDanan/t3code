import { APP_BASE_NAME, APP_VERSION, T3_CODE_BASE_VERSION } from "@t3tools/shared/appMetadata";

export { APP_BASE_NAME, APP_VERSION, T3_CODE_BASE_VERSION };

export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : "Alpha";
export const APP_DISPLAY_NAME = `${APP_BASE_NAME} (${APP_STAGE_LABEL})`;
