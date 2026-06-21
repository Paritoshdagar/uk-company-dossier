#!/usr/bin/env node

import { gitRoot, log, npmCommand, runOrFail } from "./verify-lib.mjs";

const root = await gitRoot();
const skipHeavy =
  process.env.UK_COMPANY_DOSSIER_SKIP_HEAVY_GATES_FOR_TESTS === "1";

await runOrFail(
  "Running commit gate",
  process.execPath,
  ["scripts/verify-commit.mjs"],
  { cwd: root },
);

if (skipHeavy) {
  log("Skipping push-only heavy gates for verification-script tests");
  log("Push verification passed");
  process.exit(0);
}

await runOrFail("Running coverage", npmCommand(), ["run", "test:coverage"], {
  cwd: root,
});
await runOrFail(
  "Running production dependency audit",
  npmCommand(),
  ["audit", "--omit=dev"],
  { cwd: root },
);

log("Push verification passed");
