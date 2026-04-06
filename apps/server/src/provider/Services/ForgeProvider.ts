import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface ForgeProviderShape extends ServerProviderShape {}

export class ForgeProvider extends ServiceMap.Service<ForgeProvider, ForgeProviderShape>()(
  "t3/provider/Services/ForgeProvider",
) {}
