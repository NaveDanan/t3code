import { Effect, Layer, Stream } from "effect";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { OpencodeAdapter, type OpencodeAdapterShape } from "../Services/OpencodeAdapter.ts";

const PROVIDER = "opencode" as const;
const UNIMPLEMENTED_MESSAGE = "OpenCode sidecar integration is not implemented yet in this build.";

const unsupportedOperation = (method: string) =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: UNIMPLEMENTED_MESSAGE,
    }),
  );

const makeOpencodeAdapter = Effect.succeed({
  provider: PROVIDER,
  capabilities: {
    sessionModelSwitch: "unsupported",
  },
  startSession: () => unsupportedOperation("startSession"),
  sendTurn: () => unsupportedOperation("sendTurn"),
  interruptTurn: () => unsupportedOperation("interruptTurn"),
  respondToRequest: () => unsupportedOperation("respondToRequest"),
  respondToUserInput: () => unsupportedOperation("respondToUserInput"),
  stopSession: () => Effect.void,
  listSessions: () => Effect.succeed([]),
  hasSession: () => Effect.succeed(false),
  readThread: () => unsupportedOperation("readThread"),
  rollbackThread: () => unsupportedOperation("rollbackThread"),
  stopAll: () => Effect.void,
  streamEvents: Stream.empty,
} satisfies OpencodeAdapterShape);

export const OpencodeAdapterLive = Layer.effect(OpencodeAdapter, makeOpencodeAdapter);

export function makeOpencodeAdapterLive() {
  return Layer.effect(OpencodeAdapter, makeOpencodeAdapter);
}
