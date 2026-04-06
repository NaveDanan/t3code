import { describe, expect, it } from "vitest";

import {
  buildForgeSpawnSpec,
  buildForgeAdapterKey,
  buildForgeModelSlug,
  buildForgeWslSpawnSpec,
  normalizeForgeBinaryPath,
  buildForgeWslShellCommand,
  parseDefaultWslDistro,
  parseForgeAdapterKey,
  parseForgeModelCatalogRows,
  parseForgeProviderCatalogRows,
  resolveForgeBinaryPathForGitBash,
  resolveForgeModel,
  toGitBashPath,
} from "./forgecode.ts";

function formatPorcelainRow(values: ReadonlyArray<string>, widths: ReadonlyArray<number>): string {
  return values
    .map((value, index) => {
      const padded = value.padEnd(widths[index] ?? value.length);
      return index === values.length - 1 ? padded : `${padded}  `;
    })
    .join("");
}

describe("parseForgeProviderCatalogRows", () => {
  it("parses provider auth rows from Forge porcelain output", () => {
    const widths = [20, 18, 26, 12] as const;
    const rows = parseForgeProviderCatalogRows(
      [
        formatPorcelainRow(["NAME", "ID", "HOST", "LOGGED IN"], widths),
        formatPorcelainRow(
          ["GitHub Copilot", "github_copilot", "https://api.github.com", "[yes]"],
          widths,
        ),
        formatPorcelainRow(["Anthropic", "anthropic", "[empty]", "[no]"], widths),
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        name: "GitHub Copilot",
        id: "github_copilot",
        host: "https://api.github.com",
        loggedIn: true,
      },
      {
        name: "Anthropic",
        id: "anthropic",
        host: "[empty]",
        loggedIn: false,
      },
    ]);
  });
});

describe("parseForgeModelCatalogRows", () => {
  it("parses model rows and preserves provider-scoped identity", () => {
    const widths = [16, 18, 18, 16, 18, 8, 8] as const;
    const rows = parseForgeModelCatalogRows(
      [
        formatPorcelainRow(
          ["MODEL", "PROVIDER", "PROVIDER ID", "ID", "CONTEXT WINDOW", "TOOLS", "IMAGE"],
          widths,
        ),
        formatPorcelainRow(
          ["GPT-5.4", "GitHub Copilot", "github_copilot", "gpt-5.4", "128k", "[yes]", "[no]"],
          widths,
        ),
        formatPorcelainRow(
          ["Claude Sonnet", "Anthropic", "anthropic", "sonnet-4-6", "200k", "[no]", "[yes]"],
          widths,
        ),
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        id: "gpt-5.4",
        model: "GPT-5.4",
        provider: "GitHub Copilot",
        providerId: "github_copilot",
        contextWindow: "128k",
        tools: true,
        image: false,
      },
      {
        id: "sonnet-4-6",
        model: "Claude Sonnet",
        provider: "Anthropic",
        providerId: "anthropic",
        contextWindow: "200k",
        tools: false,
        image: true,
      },
    ]);
  });
});

describe("resolveForgeModel", () => {
  const catalog = [
    {
      id: "gpt-5.4",
      model: "GPT-5.4",
      provider: "GitHub Copilot",
      providerId: "github_copilot",
    },
    {
      id: "gpt-5.4",
      model: "GPT-5.4",
      provider: "OpenAI",
      providerId: "openai",
    },
    {
      id: "sonnet-4-6",
      model: "Claude Sonnet 4.6",
      provider: "Anthropic",
      providerId: "anthropic",
    },
  ] as const;

  it("resolves canonical provider-qualified slugs directly", () => {
    expect(resolveForgeModel("github_copilot/gpt-5.4", catalog)).toEqual({
      providerId: "github_copilot",
      modelId: "gpt-5.4",
      slug: buildForgeModelSlug("github_copilot", "gpt-5.4"),
      providerName: "GitHub Copilot",
      modelName: "GPT-5.4",
    });
  });

  it("resolves legacy bare model ids only when the match is unique", () => {
    expect(resolveForgeModel("sonnet-4-6", catalog)).toEqual({
      providerId: "anthropic",
      modelId: "sonnet-4-6",
      slug: buildForgeModelSlug("anthropic", "sonnet-4-6"),
      providerName: "Anthropic",
      modelName: "Claude Sonnet 4.6",
    });
    expect(resolveForgeModel("gpt-5.4", catalog)).toBeUndefined();
  });
});

describe("buildForgeWslShellCommand", () => {
  it("normalizes the legacy Forge binary path to the PATH-based command", () => {
    expect(normalizeForgeBinaryPath("~/.local/bin/forge")).toBe("forge");
  });

  it("builds a WSL shell command with cwd and per-process env overrides", () => {
    const command = buildForgeWslShellCommand({
      binaryPath: "forge",
      forgeArgs: ["--prompt", "hello world", "--conversation-id", "uuid-123"],
      cwd: "D:\\Projects\\t3code",
      env: {
        FORGE_SESSION__PROVIDER_ID: "github_copilot",
        FORGE_SESSION__MODEL_ID: "gpt-5.4",
      },
    });

    expect(command).toContain("cd '/mnt/d/Projects/t3code' &&");
    expect(command).toContain("FORGE_SESSION__PROVIDER_ID='github_copilot'");
    expect(command).toContain("FORGE_SESSION__MODEL_ID='gpt-5.4'");
    expect(command).toContain("'forge' '--prompt' 'hello world' '--conversation-id' 'uuid-123'");
  });
});

describe("buildForgeWslSpawnSpec", () => {
  it("uses wsl.exe with shell disabled so Forge does not hang behind cmd.exe", () => {
    const spec = buildForgeWslSpawnSpec({
      binaryPath: "forge",
      forgeArgs: ["--version"],
    });

    expect(spec.command).toBe("wsl.exe");
    expect(spec.args).toEqual(["zsh", "-i", "-l", "-c", "'forge' '--version'"]);
    expect(spec.shell).toBe(false);
  });
});

describe("buildForgeSpawnSpec", () => {
  it("uses an interactive login Git Bash shell so forge resolves from the user shell setup", () => {
    const spec = buildForgeSpawnSpec({
      binaryPath: "custom-forge",
      forgeArgs: ["--version"],
      executionTarget: {
        executionBackend: "gitbash",
        gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      },
    });

    expect(spec.command).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(spec.args).toEqual(["-i", "-l", "-c", "'custom-forge' '--version'"]);
    expect(spec.shell).toBe(false);
  });
});

describe("resolveForgeBinaryPathForGitBash", () => {
  it("converts Windows absolute paths into Git Bash paths", () => {
    expect(
      resolveForgeBinaryPathForGitBash(
        "C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\forge.exe",
      ),
    ).toBe("/c/Users/test/AppData/Local/Programs/Forge/forge.exe");
  });

  it("uses the discovered Windows Forge install when the configured path is the default command", () => {
    expect(
      resolveForgeBinaryPathForGitBash(
        "forge",
        "C:\\Users\\test\\AppData\\Local\\Programs\\Forge\\forge.exe",
      ),
    ).toBe("/c/Users/test/AppData/Local/Programs/Forge/forge.exe");
  });
});

describe("toGitBashPath", () => {
  it("rewrites Windows drive paths to Git Bash mount paths", () => {
    expect(toGitBashPath("D:\\Projects\\t3code")).toBe("/d/Projects/t3code");
  });
});

describe("parseDefaultWslDistro", () => {
  it("extracts the default distro from wsl --status output", () => {
    expect(parseDefaultWslDistro("Default Distribution: Ubuntu-24.04\nDefault Version: 2\n")).toBe(
      "Ubuntu-24.04",
    );
  });

  it("extracts the default distro from UTF-16 style wsl --status output", () => {
    expect(
      parseDefaultWslDistro(
        "D\u0000e\u0000f\u0000a\u0000u\u0000l\u0000t\u0000 \u0000D\u0000i\u0000s\u0000t\u0000r\u0000i\u0000b\u0000u\u0000t\u0000i\u0000o\u0000n\u0000:\u0000 \u0000U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000-\u00002\u00004\u0000.\u00000\u00004\u0000\r\u0000\n\u0000",
      ),
    ).toBe("Ubuntu-24.04");
  });

  it("falls back to parsing the starred distro from wsl -l -v output", () => {
    expect(
      parseDefaultWslDistro(
        "  NAME              STATE           VERSION\n* Ubuntu-24.04      Running         2\n  docker-desktop    Running         2\n",
      ),
    ).toBe("Ubuntu-24.04");
  });
});

describe("Forge adapter keys", () => {
  it("round-trips backend identity through adapter keys", () => {
    const adapterKey = buildForgeAdapterKey({
      executionBackend: "wsl",
      wslDistro: "Ubuntu-24.04",
    });

    expect(adapterKey).toBe("forgecode:wsl:Ubuntu-24.04");
    expect(parseForgeAdapterKey(adapterKey)).toEqual({
      executionBackend: "wsl",
      wslDistro: "Ubuntu-24.04",
    });
  });
});
