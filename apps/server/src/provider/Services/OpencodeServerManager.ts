import type {
  ConfigProvidersResponse,
  GlobalEvent,
  OpencodeClient,
  ProviderAuthMethod,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2";
import { Context, Effect, Schema } from "effect";
import type { Stream } from "effect";

export type OpencodeConfiguredProvider = ConfigProvidersResponse["providers"][number];
export type OpencodeKnownProvider = ProviderListResponse["all"][number];
export type OpencodeServerEvent = GlobalEvent;

export interface OpencodeServerHandle {
  readonly binaryPath: string;
  readonly url: string;
  readonly client: OpencodeClient;
  readonly version: string;
}

export interface OpencodeServerProbe {
  readonly server: OpencodeServerHandle;
  readonly configuredProviders: ReadonlyArray<OpencodeConfiguredProvider>;
  readonly knownProviders: ReadonlyArray<OpencodeKnownProvider>;
  readonly connectedProviderIds: ReadonlyArray<string>;
  readonly authMethodsByProviderId: Readonly<Record<string, ReadonlyArray<ProviderAuthMethod>>>;
  readonly defaultModelByProviderId: Readonly<Record<string, string>>;
}

export class OpencodeServerManagerError extends Schema.TaggedErrorClass<OpencodeServerManagerError>()(
  "OpencodeServerManagerError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `OpenCode server manager failed in ${this.operation}: ${this.detail}`;
  }
}

export interface OpencodeServerManagerShape {
  readonly ensureServer: (input: {
    readonly binaryPath: string;
  }) => Effect.Effect<OpencodeServerHandle, OpencodeServerManagerError>;
  readonly probe: (input: {
    readonly binaryPath: string;
  }) => Effect.Effect<OpencodeServerProbe, OpencodeServerManagerError>;
  readonly streamEvents: (input: {
    readonly binaryPath: string;
  }) => Stream.Stream<OpencodeServerEvent>;
  readonly stop: Effect.Effect<void>;
}

export class OpencodeServerManager extends Context.Service<
  OpencodeServerManager,
  OpencodeServerManagerShape
>()("t3/provider/Services/OpencodeServerManager") {}
