import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface ForgeProviderShape extends ServerProviderShape {}

export class ForgeProvider extends Context.Service<ForgeProvider, ForgeProviderShape>()(
  "t3/provider/Services/ForgeProvider",
) {}
