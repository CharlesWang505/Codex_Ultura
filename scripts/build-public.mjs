import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remapPrefixes = [os.homedir(), projectRoot]
  .filter(Boolean)
  .map((prefix, index) => `--remap-path-prefix=${prefix}=PUBLIC_PATH_${index + 1}`);

const existingFlags = (process.env.CARGO_ENCODED_RUSTFLAGS || "")
  .split("\x1f")
  .filter(Boolean);
const executable = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(executable, ["tauri", "build", "--bundles", "nsis"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: [...existingFlags, ...remapPrefixes].join("\x1f"),
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
