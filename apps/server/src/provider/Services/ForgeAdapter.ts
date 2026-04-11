import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ForgeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "forgecode";
}

export class ForgeAdapter extends Context.Service<ForgeAdapter, ForgeAdapterShape>()(
  "t3/provider/Services/ForgeAdapter",
) {}
