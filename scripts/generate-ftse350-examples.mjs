#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { format as formatWithPrettier } from "prettier";

import { createCompaniesHouseClient } from "../dist/companies-house/client.js";
import { parseEnvironment } from "../dist/config/environment.js";
import {
  formatRandomSelectionManifest,
  selectRandomCompanies,
  validateRandomPickerCandidateSnapshot,
  validateRandomSelectionPolicy,
} from "../dist/examples/random-picker.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const examplesDirectory = join(root, "examples", "ftse350");
const candidateSnapshotPath = join(
  examplesDirectory,
  "candidate-snapshot.json",
);
const selectionPolicyPath = join(examplesDirectory, "selection-policy.json");
const selectionManifestPath = join(
  examplesDirectory,
  "selection-manifest.json",
);
const liveSummaryJsonPath = join(examplesDirectory, "live-summary.json");
const liveSummaryMarkdownPath = join(examplesDirectory, "live-summary.md");
const seed = "ftse350-public-demo-v1";
const disclaimer =
  "Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.";

loadDotenv({ quiet: true });

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function createClientContext() {
  const environment = parseEnvironment(process.env);

  if (environment.getApiKey() === undefined) {
    throw new Error(
      "COMPANIES_HOUSE_API_KEY is required. Run npm run env:init, add your key to .env, then retry.",
    );
  }

  return {
    apiBaseUrl: environment.apiBaseUrl,
    client: createCompaniesHouseClient({
      apiBaseUrl: environment.apiBaseUrl,
      getApiKey: environment.getApiKey,
      userAgent: "uk-company-dossier-example-generator/0.1.0",
    }),
  };
}

async function companiesHouseJson(path, context) {
  try {
    const response = await context.client.requestJson(path);

    return {
      ok: true,
      payload: response.data,
      sourceUri: response.requestedUrl,
      status: "complete",
      statusCode: response.status,
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 404
    ) {
      return {
        ok: false,
        sourceUri: `${context.apiBaseUrl}${path}`,
        status: "not_available",
        statusCode: 404,
      };
    }

    throw error;
  }
}

function numericCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function listSection(result, countKeys) {
  if (!result.ok) {
    return {
      evidenceSourceCount: 1,
      itemCount: 0,
      sampledItemCount: 0,
      sourceUri: result.sourceUri,
      status: result.status,
    };
  }

  const itemCount = countKeys.reduce(
    (count, key) => (count === 0 ? numericCount(result.payload[key]) : count),
    0,
  );

  return {
    evidenceSourceCount: 1,
    itemCount,
    sampledItemCount: Array.isArray(result.payload.items)
      ? result.payload.items.length
      : 0,
    sourceUri: result.sourceUri,
    status: result.status,
  };
}

function profileFacts(profile) {
  return [
    profile.company_number,
    profile.company_name,
    profile.company_status,
    profile.type,
    profile.jurisdiction,
    profile.date_of_creation,
  ].filter((value) => typeof value === "string" && value.length > 0).length;
}

function profileSection(result) {
  if (!result.ok) {
    return {
      evidenceSourceCount: 1,
      factCount: 0,
      sourceUri: result.sourceUri,
      status: result.status,
    };
  }

  return {
    evidenceSourceCount: 1,
    factCount: profileFacts(result.payload),
    sourceUri: result.sourceUri,
    status: result.status,
  };
}

function insolvencySection(result) {
  if (!result.ok) {
    return {
      caseCount: 0,
      evidenceSourceCount: 1,
      sourceUri: result.sourceUri,
      status: result.status,
    };
  }

  const cases = Array.isArray(result.payload.cases) ? result.payload.cases : [];

  return {
    caseCount: cases.length,
    evidenceSourceCount: 1,
    sourceUri: result.sourceUri,
    status: result.status,
  };
}

async function summarizeCompany(record, context) {
  const companyPath = `/company/${record.companyNumber}`;
  const profile = await companiesHouseJson(companyPath, context);
  const filings = await companiesHouseJson(
    `${companyPath}/filing-history?items_per_page=1`,
    context,
  );
  const officers = await companiesHouseJson(
    `${companyPath}/officers?items_per_page=1`,
    context,
  );
  const pscs = await companiesHouseJson(
    `${companyPath}/persons-with-significant-control?items_per_page=1`,
    context,
  );
  const charges = await companiesHouseJson(
    `${companyPath}/charges?items_per_page=1`,
    context,
  );
  const insolvency = await companiesHouseJson(
    `${companyPath}/insolvency`,
    context,
  );

  if (!profile.ok) {
    throw new Error(
      `Company profile was unavailable for selected company ${record.companyNumber}.`,
    );
  }

  return {
    company: {
      companyNumber: profile.payload.company_number,
      registeredName: profile.payload.company_name,
      status: profile.payload.company_status,
      type: profile.payload.type,
    },
    evidence: {
      retrievedAt: new Date().toISOString(),
      sourceUri: context.apiBaseUrl,
    },
    sections: {
      charges: listSection(charges, ["total_count"]),
      filings: listSection(filings, ["total_count"]),
      insolvency: insolvencySection(insolvency),
      officers: listSection(officers, ["total_results", "total_count"]),
      profile: profileSection(profile),
      pscs: listSection(pscs, ["total_results", "total_count"]),
    },
    selection: {
      eligibilityPool: record.eligibilityPool,
      hash: record.hash,
      rank: record.rank,
      selectionStatus: record.selectionStatus,
    },
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatMarkdown(summary) {
  const rows = summary.selectedCompanies
    .map((company) => {
      const sections = [
        `profile: ${markdownCell(company.sections.profile.status)} (${company.sections.profile.factCount} facts)`,
        `filings: ${markdownCell(company.sections.filings.status)} (${company.sections.filings.itemCount} total)`,
        `officers: ${markdownCell(company.sections.officers.status)} (${company.sections.officers.itemCount} total)`,
        `pscs: ${markdownCell(company.sections.pscs.status)} (${company.sections.pscs.itemCount} total)`,
        `charges: ${markdownCell(company.sections.charges.status)} (${company.sections.charges.itemCount} total)`,
        `insolvency: ${markdownCell(company.sections.insolvency.status)} (${company.sections.insolvency.caseCount} cases)`,
      ].join("<br>");

      return `| ${markdownCell(company.company.companyNumber)} | ${markdownCell(company.company.registeredName)} | ${markdownCell(company.company.status)} | ${company.selection.rank} | ${sections} |`;
    })
    .join("\n");

  return `# FTSE 350 live example summary

${summary.disclaimer}

Generated at: ${summary.generatedAt}

Source: ${summary.sources.candidateSourceUri}

| Company number | Registered name | Status | Random rank | Section summary |
| --- | --- | --- | ---: | --- |
${rows}

These rows are compact software-output examples. They omit raw payloads, officer names, PSC names, filing rows, addresses, API keys, and Authorization headers.
`;
}

await mkdir(examplesDirectory, { recursive: true });

const clientContext = createClientContext();
const [candidateSnapshot, selectionPolicy] = await Promise.all([
  readJson(candidateSnapshotPath),
  readJson(selectionPolicyPath),
]);
const manifest = selectRandomCompanies(
  validateRandomPickerCandidateSnapshot(candidateSnapshot),
  validateRandomSelectionPolicy(selectionPolicy),
  seed,
);

await writeFile(selectionManifestPath, formatRandomSelectionManifest(manifest));

const selectedCompanies = [];

for (const record of manifest.selectedRecords) {
  if (record.selectionStatus === "selected") {
    selectedCompanies.push(await summarizeCompany(record, clientContext));
  }
}

const summary = {
  schemaVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  disclaimer,
  seed,
  sources: {
    candidateSourceUri: candidateSnapshot.snapshotUri,
    companiesHouseSourceUri: clientContext.apiBaseUrl,
    selectionManifestPolicyHash: manifest.policyHash,
  },
  selectedCompanies,
};

await writeFile(liveSummaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(
  liveSummaryMarkdownPath,
  await formatWithPrettier(formatMarkdown(summary), { parser: "markdown" }),
);
