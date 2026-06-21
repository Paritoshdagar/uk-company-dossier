#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  commandExists,
  fail,
  gitOutput,
  gitRoot,
  log,
  npmCommand,
  run,
  runOrFail,
} from "./verify-lib.mjs";

const root = await gitRoot();
const skipHeavy =
  process.env.UK_COMPANY_DOSSIER_SKIP_HEAVY_GATES_FOR_TESTS === "1";
const evidenceDirectory = join(root, "release-evidence-private");
const evidencePath = join(evidenceDirectory, "release-evidence.json");
const schemaPath = join(root, "schemas/release-evidence.schema.json");

async function sha256File(relativePath) {
  const bytes = await readFile(join(root, relativePath));

  return createHash("sha256").update(bytes).digest("hex");
}

async function githubVisibility() {
  if (skipHeavy || !(await commandExists("gh"))) {
    return "unknown";
  }

  const result = await run(
    "gh",
    ["repo", "view", "--json", "visibility", "--jq", ".visibility"],
    {
      cwd: root,
    },
  );

  if (result.code !== 0) {
    return "unknown";
  }

  return result.stdout.trim();
}

async function runHistorySecretScan() {
  if (skipHeavy || !(await commandExists("gitleaks"))) {
    return "not-recorded";
  }

  log("Running Git history secret scan");
  const logResult = await run(
    "git",
    ["log", "--all", "-p", "--", ".", ":!package-lock.json"],
    {
      cwd: root,
    },
  );

  if (logResult.code !== 0) {
    fail(
      logResult.stderr.trim() || "Unable to read Git history for secret scan.",
    );
  }

  const scanResult = await run("gitleaks", ["stdin", "--redact"], {
    cwd: root,
    input: logResult.stdout,
    stdio: "inherit",
  });

  if (scanResult.code !== 0) {
    fail("Git history secret scan failed.");
  }

  return "passed";
}

async function writeEvidence(input) {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(input, null, 2)}\n`);
}

async function validateEvidence() {
  const [evidence, schema] = await Promise.all([
    readFile(evidencePath, "utf8").then((text) => JSON.parse(text)),
    readFile(schemaPath, "utf8").then((text) => JSON.parse(text)),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });

  addFormats(ajv);

  const validate = ajv.compile(schema);

  if (!validate(evidence)) {
    process.stderr.write(`${JSON.stringify(validate.errors, null, 2)}\n`);
    process.exit(1);
  }
}

await runOrFail(
  "Running push gate",
  process.execPath,
  ["scripts/verify-push.mjs"],
  { cwd: root },
);

if (!skipHeavy) {
  await runOrFail("Running full dependency audit", npmCommand(), ["audit"], {
    cwd: root,
  });

  if (await commandExists("osv-scanner")) {
    await runOrFail(
      "Running OSV lockfile scan",
      "osv-scanner",
      ["scan", "source", "--lockfile", "package-lock.json"],
      { cwd: root },
    );
  } else {
    log("osv-scanner not installed; skipping local OSV scan");
  }
}

const visibility = await githubVisibility();

if (!skipHeavy && visibility !== "PRIVATE") {
  fail(`GitHub repository visibility is ${visibility}, expected PRIVATE.`);
}

const historySecretScanStatus = await runHistorySecretScan();
const trackedFiles = (await gitOutput(["ls-files"], root))
  .split(/\r?\n/u)
  .filter(Boolean);
const evidence = {
  schemaVersion: "1.0.0",
  repository: "uk-company-dossier",
  generatedAt: new Date().toISOString(),
  commitSha: (await gitOutput(["rev-parse", "HEAD"], root)).trim(),
  git: {
    visibility,
    trackedFileCount: trackedFiles.length,
  },
  checks: [
    { name: "verify-push", status: "passed" },
    { name: "history-secret-scan", status: historySecretScanStatus },
  ],
  artifacts: {
    companyEvidenceSchemaSha256: await sha256File(
      "schemas/company-evidence.schema.json",
    ),
    packageLockSha256: await sha256File("package-lock.json"),
  },
};

await writeEvidence(evidence);
await validateEvidence();

log(
  `Release evidence written to ${join("release-evidence-private", "release-evidence.json")}`,
);
log("Release verification passed");
