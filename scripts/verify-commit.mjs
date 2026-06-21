#!/usr/bin/env node

import {
  collectFiles,
  commandExists,
  fail,
  gitOutput,
  gitRoot,
  log,
  normaliseGitPath,
  npmCommand,
  readRepositoryText,
  run,
  runOrFail,
} from "./verify-lib.mjs";

const root = await gitRoot();
const skipHeavy =
  process.env.UK_COMPANY_DOSSIER_SKIP_HEAVY_GATES_FOR_TESTS === "1";

async function checkForbiddenTrackedPaths() {
  log("Checking forbidden tracked paths");
  const trackedFiles = (await gitOutput(["ls-files"], root))
    .split(/\r?\n/u)
    .map(normaliseGitPath)
    .filter(Boolean);
  const forbidden = trackedFiles.filter((path) => {
    const parts = path.split("/");
    const basename = parts.at(-1) ?? "";
    const privatePlanPath = ["docs", "superpowers"].join("/");
    const privateEvidencePath = ["release-evidence", "private"].join("-");

    return (
      (basename.startsWith(".env") && basename !== ".env.example") ||
      path === privatePlanPath ||
      path.startsWith(`${privatePlanPath}/`) ||
      path === privateEvidencePath ||
      path.startsWith(`${privateEvidencePath}/`)
    );
  });

  if (forbidden.length > 0) {
    for (const path of forbidden) {
      process.stderr.write(`Forbidden tracked path: ${path}\n`);
    }

    process.exit(1);
  }
}

async function checkPublicPrivacyPatterns() {
  log(
    "Checking public files for private paths and concrete API-key assignments",
  );
  const privateTerms = [
    ["docs", "superpowers"].join("/"),
    ["private", "specification"].join(" "),
    [["FTSE", "100"].join(" "), "executive"].join(" "),
    ["ProjectPhoenix", "FComHouseAPI"].join("-"),
    ["/Users", "paritoshdagar"].join("/"),
  ];
  const concreteApiKeyAssignmentPattern = new RegExp(
    `${["COMPANIES_HOUSE_API", "KEY"].join("_")}=\\S+`,
    "u",
  );
  const targets = [
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "package.json",
    ...(await collectFiles(root, "docs")),
    ...(await collectFiles(root, "examples")),
    ...(await collectFiles(root, "scripts")),
  ];

  for (const relativePath of targets) {
    const text = await readRepositoryText(root, relativePath);

    for (const privateTerm of privateTerms) {
      if (text.includes(privateTerm)) {
        fail(`Private term found in ${relativePath}.`);
      }
    }

    if (concreteApiKeyAssignmentPattern.test(text)) {
      fail(
        `Concrete Companies House API key assignment found in ${relativePath}.`,
      );
    }
  }
}

async function checkGitWhitespace() {
  await runOrFail("Checking Git whitespace", "git", ["diff", "--check"], {
    cwd: root,
  });
  await runOrFail(
    "Checking staged Git whitespace",
    "git",
    ["diff", "--cached", "--check"],
    {
      cwd: root,
    },
  );
}

async function runHeavyGates() {
  if (skipHeavy) {
    log("Skipping heavy gates for verification-script tests");
    return;
  }

  await runOrFail(
    "Running documentation link checks",
    npmCommand(),
    ["run", "docs:links"],
    { cwd: root },
  );
  await runOrFail(
    "Running Mermaid documentation checks",
    npmCommand(),
    ["run", "docs:mermaid"],
    { cwd: root },
  );
  await runOrFail(
    "Running format check",
    npmCommand(),
    ["run", "format:check"],
    {
      cwd: root,
    },
  );
  await runOrFail("Running lint", npmCommand(), ["run", "lint"], { cwd: root });
  await runOrFail("Running typecheck", npmCommand(), ["run", "typecheck"], {
    cwd: root,
  });
  await runOrFail("Running tests", npmCommand(), ["test"], { cwd: root });
  await runOrFail("Running build", npmCommand(), ["run", "build"], {
    cwd: root,
  });

  if (await commandExists("gitleaks")) {
    await runOrFail(
      "Running working-tree secret scan",
      "gitleaks",
      ["detect", "--source", ".", "--no-git", "--redact", "--verbose"],
      { cwd: root },
    );
  } else {
    log("gitleaks not installed; skipping local working-tree secret scan");
  }
}

await checkForbiddenTrackedPaths();
await checkPublicPrivacyPatterns();
await checkGitWhitespace();
await runHeavyGates();

log("Commit verification passed");
