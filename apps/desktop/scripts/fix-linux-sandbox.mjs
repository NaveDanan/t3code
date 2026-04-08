#!/usr/bin/env node
/**
 * Fixes chrome-sandbox permissions required by Electron on Linux.
 *
 * The SUID sandbox helper must be owned by root with mode 4755.
 * Run once after `bun install` when developing on Linux:
 *
 *   bun run fix:sandbox
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform !== "linux") {
  console.log("fix-linux-sandbox: not Linux, skipping.");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electronBinaryPath = require("electron");
const sandboxPath = join(dirname(electronBinaryPath), "chrome-sandbox");

console.log(`[fix-linux-sandbox] Fixing permissions for:\n  ${sandboxPath}\n`);
console.log("You may be prompted for your sudo password.\n");

const chown = spawnSync("sudo", ["chown", "root:root", sandboxPath], { stdio: "inherit" });
if (chown.status !== 0) {
  console.error("chown failed — ensure you have sudo access.");
  process.exit(chown.status ?? 1);
}

const chmod = spawnSync("sudo", ["chmod", "4755", sandboxPath], { stdio: "inherit" });
if (chmod.status !== 0) {
  console.error("chmod failed — ensure you have sudo access.");
  process.exit(chmod.status ?? 1);
}

console.log("\n[fix-linux-sandbox] Done. Sandbox permissions set correctly.");
