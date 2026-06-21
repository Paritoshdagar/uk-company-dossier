#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const requiredFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "docs/companies-house-sources.md",
  "docs/mcp/claude.json.example",
  "docs/mcp/codex.toml.example",
  "docs/use-cases/non-technical-company-review.md",
  "docs/use-cases/technical-evidence-integration.md",
  "examples/fixtures/README.md",
  "examples/ftse350/README.md",
  "examples/ftse350/reference/README.md",
  "examples/non-technical/README.md",
  "examples/random-selection/README.md",
  "examples/technical/README.md",
];

const officialLinks = [
  "https://developer.company-information.service.gov.uk/",
  "https://developer.company-information.service.gov.uk/get-started",
  "https://developer.company-information.service.gov.uk/how-to-create-an-application",
  "https://developer.company-information.service.gov.uk/authentication",
  "https://developer.company-information.service.gov.uk/developer-guidelines",
  "https://developer.company-information.service.gov.uk/api-testing",
  "https://developer-specs.company-information.service.gov.uk/",
  "https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference",
  "https://developer-specs.company-information.service.gov.uk/document-api/reference",
  "https://developer-specs.company-information.service.gov.uk/document-api/reference/document-metadata",
  "https://developer-specs.company-information.service.gov.uk/document-api/reference/document-location/fetch-a-document",
  "https://www.gov.uk/guidance/companies-house-data-products",
];

const requiredReadmePhrases = [
  ".env.example",
  "Never commit `.env`.",
  "fixture mode",
  "live mode",
  "MCP",
  "limitations",
  "data attribution",
  "commercial licensing",
  "npm run docs:links",
  "npm run docs:mermaid",
];

const randomSelectionDisclaimer =
  "Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.";

const maintainerHomePathPattern = new RegExp(
  [
    "(?:^|[\\s\"'(=\\[`])/Users/[A-Za-z0-9._-]+/[A-Za-z0-9][A-Za-z0-9._-]*",
    "(?:^|[\\s\"'(=\\[`])/home/[A-Za-z0-9._-]+/(?:Documents|Desktop|Downloads|Developer|dev|code|Code|projects|workspace|workspaces|repo|repos|src|git|GitHub)(?:/|\\b)",
    String.raw`[A-Za-z]:\\Users\\[^\\\r\n]+\\`,
  ].join("|"),
  "u",
);

const apiKeyVariable = ["COMPANIES_HOUSE_API", "KEY"].join("_");
const concreteApiKeyAssignmentPattern = new RegExp(
  `${apiKeyVariable}=\\S+`,
  "u",
);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readText(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

async function assertRequiredFilesExist() {
  for (const relativePath of requiredFiles) {
    try {
      await access(join(repositoryRoot, relativePath));
    } catch {
      fail(`Required documentation file is missing: ${relativePath}`);
    }
  }
}

function assertIncludes(text, value, fileName) {
  if (!text.includes(value)) {
    fail(`${fileName} is missing required content: ${value}`);
  }
}

function assertIncludesCaseInsensitive(text, value, fileName) {
  if (!text.toLowerCase().includes(value.toLowerCase())) {
    fail(`${fileName} is missing required content: ${value}`);
  }
}

async function assertReadmeContract() {
  const readme = await readText("README.md");

  for (const link of officialLinks) {
    assertIncludes(readme, link, "README.md");
  }

  for (const phrase of requiredReadmePhrases) {
    assertIncludesCaseInsensitive(readme, phrase, "README.md");
  }

  assertIncludes(readme, randomSelectionDisclaimer, "README.md");
}

async function assertRandomSelectionDisclaimer() {
  const exampleReadme = await readText("examples/random-selection/README.md");

  assertIncludes(
    exampleReadme,
    randomSelectionDisclaimer,
    "examples/random-selection/README.md",
  );
}

async function collectFiles(relativePath) {
  const absolutePath = join(repositoryRoot, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const childRelativePath = join(relativePath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(childRelativePath)));
    } else if (entry.isFile()) {
      files.push(childRelativePath);
    }
  }

  return files;
}

async function assertNoPrivateTerms() {
  const scanTargets = [
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "package.json",
    ...(await collectFiles("docs")),
    ...(await collectFiles("examples")),
    ...(await collectFiles("scripts")),
  ];

  for (const relativePath of scanTargets) {
    const text = await readText(relativePath);

    if (concreteApiKeyAssignmentPattern.test(text)) {
      fail(
        `Concrete Companies House API key assignment found in ${relativePath}`,
      );
    }

    if (maintainerHomePathPattern.test(text)) {
      fail(`Local home-directory path found in ${relativePath}`);
    }
  }
}

function assertTemplateUsesPlaceholders(text, relativePath) {
  const requiredPlaceholders = [
    "${UK_COMPANY_DOSSIER_REPOSITORY}",
    "${COMPANIES_HOUSE_API_KEY}",
  ];
  const forbiddenPatterns = [
    /\/Users\//u,
    /C:\\Users\\/u,
    /sk-[A-Za-z0-9_-]+/u,
    /BEGIN [A-Z ]*PRIVATE KEY/u,
    /"COMPANIES_HOUSE_API_KEY"\s*:\s*"(?!\$\{COMPANIES_HOUSE_API_KEY\}")/u,
    /COMPANIES_HOUSE_API_KEY\s*=\s*"(?!\$\{COMPANIES_HOUSE_API_KEY\}")/u,
  ];

  for (const placeholder of requiredPlaceholders) {
    assertIncludes(text, placeholder, relativePath);
  }

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) {
      fail(`Unsafe MCP template value found in ${relativePath}`);
    }
  }
}

async function assertTemplateSafety() {
  const templatePaths = [
    "docs/mcp/claude.json.example",
    "docs/mcp/codex.toml.example",
  ];

  for (const relativePath of templatePaths) {
    assertTemplateUsesPlaceholders(await readText(relativePath), relativePath);
  }
}

await assertRequiredFilesExist();
await assertReadmeContract();
await assertRandomSelectionDisclaimer();
await assertNoPrivateTerms();
await assertTemplateSafety();

process.stdout.write("Documentation link checks passed.\n");
