import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface OpencodeProviderShape extends ServerProviderShape {}

export class OpencodeProvider extends Context.Service<OpencodeProvider, OpencodeProviderShape>()(
  "t3/provider/Services/OpencodeProvider",
) {}
