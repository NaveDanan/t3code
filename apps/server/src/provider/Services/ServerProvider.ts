import type { HarnessUpdateResult, ServerProvider } from "@t3tools/contracts";
import type { Effect, Stream } from "effect";

export interface ServerProviderShape {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly update: Effect.Effect<HarnessUpdateResult>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
