import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, it, assert } from "@effect/vitest";
import { Effect } from "effect";

import { makeOpencodeServerManager } from "./OpencodeServerManager";

class FakeOpencodeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid?: number | undefined = 42;

  constructor(private readonly onKill: () => void) {
    super();
  }

  override once(
    event: "error" | "exit",
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: NodeJS.Signals | null) => void),
  ): this {
    return super.once(event, listener as (...args: Array<unknown>) => void);
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.onKill();
    this.emit("exit", 0, null);
    return true;
  }
}

const providerCatalogModel = {
  id: "gpt-5",
  providerID: "openai",
  api: {
    id: "openai",
    url: "https://api.openai.com/v1",
    npm: "openai",
  },
  name: "GPT-5",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: true,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 1,
    output: 2,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 200_000,
    output: 8_000,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
} as const;

const providerListModel = {
  id: "gpt-5",
  name: "GPT-5",
  release_date: "2025-01-01",
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  limit: {
    context: 200_000,
    output: 8_000,
  },
  options: {},
} as const;

function createSpawnServer() {
  let spawnCount = 0;

  return {
    get spawnCount() {
      return spawnCount;
    },
    spawnServer: ({
      port,
    }: {
      readonly binaryPath: string;
      readonly hostname: string;
      readonly port: number;
    }) => {
      spawnCount += 1;
      const server = createServer((request, response) => {
        if (!request.url) {
          response.statusCode = 404;
          response.end();
          return;
        }

        if (request.url === "/global/health") {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ healthy: true, version: "1.3.15" }));
          return;
        }

        if (request.url === "/provider") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              all: [
                {
                  id: "openai",
                  name: "OpenAI",
                  env: [],
                  models: {
                    "gpt-5": providerListModel,
                  },
                },
              ],
              default: {
                openai: "gpt-5",
              },
              connected: ["openai"],
            }),
          );
          return;
        }

        if (request.url === "/provider/auth") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              openai: [{ type: "api", label: "API Key" }],
            }),
          );
          return;
        }

        if (request.url === "/config/providers") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              providers: [
                {
                  id: "openai",
                  name: "OpenAI",
                  source: "api",
                  env: [],
                  options: {},
                  models: {
                    "gpt-5": providerCatalogModel,
                  },
                },
              ],
              default: {
                openai: "gpt-5",
              },
            }),
          );
          return;
        }

        response.statusCode = 404;
        response.end();
      });

      void server.listen(port, "127.0.0.1");

      return new FakeOpencodeProcess(() => {
        void server.close();
      });
    },
  };
}

describe("OpencodeServerManager", () => {
  it.effect("reuses a healthy server and probes metadata through the SDK client", () =>
    Effect.gen(function* () {
      const spawn = createSpawnServer();
      const manager = yield* makeOpencodeServerManager({
        spawnServer: spawn.spawnServer as never,
      });

      const first = yield* manager.probe({ binaryPath: "opencode" });
      const second = yield* manager.probe({ binaryPath: "opencode" });

      assert.strictEqual(spawn.spawnCount, 1);
      assert.strictEqual(first.server.url, second.server.url);
      assert.strictEqual(first.server.version, "1.3.15");
      assert.deepStrictEqual(first.connectedProviderIds, ["openai"]);
      assert.strictEqual(first.defaultModelByProviderId.openai, "gpt-5");
      assert.strictEqual(first.configuredProviders[0]?.id, "openai");
      assert.strictEqual(first.knownProviders[0]?.id, "openai");

      yield* manager.stop;
    }),
  );

  it.effect("restarts the managed server when the configured binary path changes", () =>
    Effect.gen(function* () {
      const spawn = createSpawnServer();
      const manager = yield* makeOpencodeServerManager({
        spawnServer: spawn.spawnServer as never,
      });

      const first = yield* manager.ensureServer({ binaryPath: "opencode-a" });
      const second = yield* manager.ensureServer({ binaryPath: "opencode-b" });

      assert.strictEqual(spawn.spawnCount, 2);
      assert.notStrictEqual(first.url, second.url);

      yield* manager.stop;
    }),
  );
});
