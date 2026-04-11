import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OpencodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

export class OpencodeAdapter extends Context.Service<OpencodeAdapter, OpencodeAdapterShape>()(
  "t3/provider/Services/OpencodeAdapter",
) {}
