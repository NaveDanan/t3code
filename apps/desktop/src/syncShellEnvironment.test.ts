import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { syncShellEnvironment } from "./syncShellEnvironment";

const noRegistryPath = () => undefined;

describe("syncShellEnvironment", () => {
  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("preserves an inherited SSH_AUTH_SOCK value", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/login-shell.sock",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("preserves inherited values when the login shell omits them", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"]);
    expect(env.PATH).toBe("/home/linuxbrew/.linuxbrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("prepends a common per-user Git install location on windows", () => {
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "t3-sync-shell-win-"));
    const gitDir = path.join(localAppData, "Programs", "Git", "cmd");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "git.exe"), "");

    const env: NodeJS.ProcessEnv = {
      LOCALAPPDATA: localAppData,
      PATH: "C:\\Windows\\System32",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/local/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    try {
      syncShellEnvironment(env, {
        platform: "win32",
        readEnvironment,
        readRegistryPath: noRegistryPath,
      });

      expect(readEnvironment).not.toHaveBeenCalled();
      expect(env.PATH).toBe(`${gitDir};C:\\Windows\\System32`);
      expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
    } finally {
      fs.rmSync(localAppData, { recursive: true, force: true });
    }
  });

  it("does nothing on windows when no Git candidate exists", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/local/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "win32",
      readEnvironment,
      readRegistryPath: noRegistryPath,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("merges new PATH entries from the Windows registry", () => {
    const readRegistryPath = (key: string) => {
      if (key.includes("HKCU")) {
        return "C:\\Users\\test\\.npm-global;C:\\Windows\\System32";
      }
      if (key.includes("HKLM")) {
        return "C:\\Windows\\System32;C:\\ProgramData\\copilot";
      }
      return undefined;
    };

    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32",
    };

    syncShellEnvironment(env, { platform: "win32", readRegistryPath });

    expect(env.PATH).toBe(
      "C:\\Windows\\System32;C:\\Users\\test\\.npm-global;C:\\ProgramData\\copilot",
    );
  });

  it("expands %VAR% references in Windows registry PATH values", () => {
    const readRegistryPath = (key: string) => {
      if (key.includes("HKCU")) {
        return "%USERPROFILE%\\.local\\bin";
      }
      return undefined;
    };

    const env: NodeJS.ProcessEnv = {
      USERPROFILE: "C:\\Users\\dev",
      PATH: "C:\\Windows\\System32",
    };

    syncShellEnvironment(env, { platform: "win32", readRegistryPath });

    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Users\\dev\\.local\\bin");
  });
});
