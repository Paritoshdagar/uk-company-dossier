#!/usr/bin/env node

import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isWindows, runOrFail } from "./verify-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tscEntrypoint = join(root, "node_modules/typescript/bin/tsc");

await runOrFail(
  "Running TypeScript build",
  process.execPath,
  [tscEntrypoint, "--project", "tsconfig.json"],
  { cwd: root },
);

if (!isWindows) {
  await Promise.all([
    chmod(join(root, "dist/cli/main.js"), 0o755),
    chmod(join(root, "bin/dossier.mjs"), 0o755),
  ]);
}
