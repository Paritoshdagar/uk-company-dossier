#!/usr/bin/env node

import { createHash } from "node:crypto";
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
const referenceDirectory = join(examplesDirectory, "reference");
const referenceIndexPath = join(referenceDirectory, "index.json");
const referenceJsonPath = join(referenceDirectory, "reference-examples.json");
const referenceMarkdownPath = join(referenceDirectory, "reference-examples.md");
const referenceReadmePath = join(referenceDirectory, "README.md");
const seed = "ftse350-public-demo-v1";
const referenceExampleLimit = 3;
const disclaimer =
  "Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.";
const referenceTypes = [
  "charges",
  "filings",
  "insolvency",
  "officers",
  "profile",
  "pscs",
];

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

function officialSourceUri(path, context) {
  return new URL(path, context.apiBaseUrl).toString();
}

function evidenceFromResponse(response) {
  return {
    payloadSha256: createHash("sha256").update(response.rawBytes).digest("hex"),
    retrievedAt: response.retrievedAt,
    sourceUri: response.finalUrl,
    statusCode: response.status,
  };
}

async function companiesHouseJson(path, context) {
  try {
    const response = await context.client.requestJson(path);

    return {
      evidence: [evidenceFromResponse(response)],
      ok: true,
      payload: response.data,
      sourceUri: response.finalUrl,
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
        evidence: [
          {
            retrievedAt: new Date().toISOString(),
            sourceUri: officialSourceUri(path, context),
            statusCode: 404,
          },
        ],
        ok: false,
        sourceUri: officialSourceUri(path, context),
        status: "not_available",
        statusCode: 404,
      };
    }

    throw error;
  }
}

function scalarField(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return undefined;
}

function nestedField(record, path) {
  let current = record;

  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !(segment in current)
    ) {
      return undefined;
    }

    current = current[segment];
  }

  return scalarField(current);
}

function compactFields(entries) {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]) => {
      const scalarValue = scalarField(value);

      return scalarValue === undefined ? [] : [[key, scalarValue]];
    }),
  );
}

function listItems(result) {
  return result.ok && Array.isArray(result.payload.items)
    ? result.payload.items
    : [];
}

function totalResultsFromPayload(payload) {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  return (
    scalarField(payload.total_results) ??
    scalarField(payload.total_count) ??
    scalarField(payload.totalResults)
  );
}

function referenceCompany(summaryCompany) {
  return {
    companyNumber: summaryCompany.company.companyNumber,
    registeredName: summaryCompany.company.registeredName,
  };
}

function referenceExample(type, company, result, fields, note) {
  return {
    company,
    evidence: result.evidence,
    fields,
    ...(note === undefined ? {} : { note }),
    type,
  };
}

function profileReference(company, profile) {
  if (!profile.ok) {
    return referenceExample(
      "profile",
      company,
      profile,
      {
        availability: profile.status,
        statusCode: profile.statusCode,
      },
      "Company profile was unavailable at generation time.",
    );
  }

  return referenceExample(
    "profile",
    company,
    profile,
    compactFields({
      companyName: profile.payload.company_name,
      companyNumber: profile.payload.company_number,
      companyStatus: profile.payload.company_status,
      dateOfCreation: profile.payload.date_of_creation,
      jurisdiction: profile.payload.jurisdiction,
      type: profile.payload.type,
    }),
  );
}

function filingReferences(company, filings) {
  const items = listItems(filings);

  if (items.length === 0) {
    return [
      referenceExample(
        "filings",
        company,
        filings,
        compactFields({
          availability: filings.status,
          sampledItems: 0,
          statusCode: filings.statusCode,
          totalResults: filings.ok
            ? totalResultsFromPayload(filings.payload)
            : undefined,
        }),
        "No filing-history items were returned in the sampled page.",
      ),
    ];
  }

  return items.slice(0, referenceExampleLimit).map((item) =>
    referenceExample(
      "filings",
      company,
      filings,
      compactFields({
        category: item.category,
        date: item.date,
        description: item.description,
        paperFiled: item.paper_filed,
        transactionId: item.transaction_id,
        type: item.type,
      }),
    ),
  );
}

function officerReferences(company, officers) {
  const items = listItems(officers);

  if (items.length === 0) {
    return [
      referenceExample(
        "officers",
        company,
        officers,
        compactFields({
          availability: officers.status,
          sampledItems: 0,
          statusCode: officers.statusCode,
          totalResults: officers.ok
            ? totalResultsFromPayload(officers.payload)
            : undefined,
        }),
        "No officer items were returned in the sampled page.",
      ),
    ];
  }

  return items.slice(0, referenceExampleLimit).map((item) =>
    referenceExample(
      "officers",
      company,
      officers,
      compactFields({
        appointedOn: item.appointed_on,
        countryOfResidence: item.country_of_residence,
        name: item.name,
        nationality: item.nationality,
        occupation: item.occupation,
        officerRole: item.officer_role,
        resignedOn: item.resigned_on,
      }),
      "Officer names and appointments are public-register information.",
    ),
  );
}

function pscReferences(company, pscs) {
  const items = listItems(pscs);

  if (items.length === 0) {
    return [
      referenceExample(
        "pscs",
        company,
        pscs,
        compactFields({
          availability: pscs.status,
          sampledItems: 0,
          statusCode: pscs.statusCode,
          totalResults: pscs.ok ? totalResultsFromPayload(pscs.payload) : 0,
        }),
        "No PSC items were returned in the sampled page. Large listed PLCs commonly report no current PSCs on this endpoint.",
      ),
    ];
  }

  return items.slice(0, referenceExampleLimit).map((item) =>
    referenceExample(
      "pscs",
      company,
      pscs,
      compactFields({
        ceasedOn: item.ceased_on,
        kind: item.kind,
        name: item.name,
        notifiedOn: item.notified_on,
      }),
      "PSC names, where present, are public-register information.",
    ),
  );
}

function chargeReferences(company, charges) {
  const items = listItems(charges);

  if (items.length === 0) {
    return [
      referenceExample(
        "charges",
        company,
        charges,
        compactFields({
          availability: charges.status,
          sampledItems: 0,
          statusCode: charges.statusCode,
          totalResults: charges.ok
            ? totalResultsFromPayload(charges.payload)
            : 0,
        }),
        "No charge items were returned in the sampled page.",
      ),
    ];
  }

  return items.slice(0, referenceExampleLimit).map((item) =>
    referenceExample(
      "charges",
      company,
      charges,
      compactFields({
        chargeCode: item.charge_code,
        classificationType: nestedField(item, ["classification", "type"]),
        createdOn: item.created_on,
        deliveredOn: item.delivered_on,
        personsEntitledCount: Array.isArray(item.persons_entitled)
          ? item.persons_entitled.length
          : undefined,
        satisfiedOn: item.satisfied_on,
        status: item.status,
      }),
    ),
  );
}

function insolvencyReferences(company, insolvency) {
  if (!insolvency.ok) {
    return [
      referenceExample(
        "insolvency",
        company,
        insolvency,
        compactFields({
          availability: insolvency.status,
          caseCount: 0,
          statusCode: insolvency.statusCode,
        }),
        "The insolvency endpoint returned 404 at generation time, so this is an availability example rather than an insolvency case.",
      ),
    ];
  }

  const cases = Array.isArray(insolvency.payload.cases)
    ? insolvency.payload.cases
    : [];

  if (cases.length === 0) {
    return [
      referenceExample(
        "insolvency",
        company,
        insolvency,
        compactFields({
          availability: insolvency.status,
          caseCount: 0,
          statusCode: insolvency.statusCode,
        }),
        "No insolvency cases were returned by the endpoint at generation time.",
      ),
    ];
  }

  return cases.slice(0, referenceExampleLimit).map((item) =>
    referenceExample(
      "insolvency",
      company,
      insolvency,
      compactFields({
        caseNumber: item.number,
        caseType: item.type,
        dateCount: Array.isArray(item.dates) ? item.dates.length : undefined,
      }),
    ),
  );
}

async function referenceExamplesForCompany(summaryCompany, context) {
  const company = referenceCompany(summaryCompany);
  const companyPath = `/company/${company.companyNumber}`;
  const profile = await companiesHouseJson(companyPath, context);
  const filings = await companiesHouseJson(
    `${companyPath}/filing-history?items_per_page=3`,
    context,
  );
  const officers = await companiesHouseJson(
    `${companyPath}/officers?items_per_page=3`,
    context,
  );
  const pscs = await companiesHouseJson(
    `${companyPath}/persons-with-significant-control?items_per_page=3`,
    context,
  );
  const charges = await companiesHouseJson(
    `${companyPath}/charges?items_per_page=3`,
    context,
  );
  const insolvency = await companiesHouseJson(
    `${companyPath}/insolvency`,
    context,
  );

  return {
    charges: chargeReferences(company, charges),
    filings: filingReferences(company, filings),
    insolvency: insolvencyReferences(company, insolvency),
    officers: officerReferences(company, officers),
    profile: [profileReference(company, profile)],
    pscs: pscReferences(company, pscs),
  };
}

async function buildReferenceExamples(summary, context) {
  const examplesByType = Object.fromEntries(
    referenceTypes.map((type) => [type, []]),
  );
  const perCompanyExamples = [];

  for (const summaryCompany of summary.selectedCompanies) {
    perCompanyExamples.push(
      await referenceExamplesForCompany(summaryCompany, context),
    );
  }

  for (
    let sampleIndex = 0;
    sampleIndex < referenceExampleLimit;
    sampleIndex += 1
  ) {
    for (const type of referenceTypes) {
      for (const companyExamples of perCompanyExamples) {
        if (examplesByType[type].length >= referenceExampleLimit) {
          break;
        }

        const example = companyExamples[type][sampleIndex];

        if (example !== undefined) {
          examplesByType[type].push(example);
        }
      }
    }
  }

  return {
    schemaVersion: "1.0.0",
    generatedAt: summary.generatedAt,
    disclaimer,
    source: {
      companiesHouseApiBaseUri: summary.sources.companiesHouseSourceUri,
      selectionManifest: "selection-manifest.json",
    },
    examplesByType,
  };
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

function formatFields(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${markdownCell(key)}: ${markdownCell(value)}`)
    .join("<br>");
}

function formatReferenceMarkdown(referenceExamples) {
  const sections = referenceTypes
    .map((type) => {
      const rows = referenceExamples.examplesByType[type]
        .map(
          (example) =>
            `| ${markdownCell(example.company.companyNumber)} | ${markdownCell(example.company.registeredName)} | ${formatFields(example.fields)} | ${markdownCell(example.evidence.map((entry) => entry.sourceUri).join(", "))} | ${markdownCell(example.note ?? "")} |`,
        )
        .join("\n");

      return `## ${type}

| Company number | Company | Example fields | Companies House source | Note |
| --- | --- | --- | --- | --- |
${rows}`;
    })
    .join("\n\n");

  return `# Evidence-linked reference examples

${referenceExamples.disclaimer}

Generated at: ${referenceExamples.generatedAt}

These examples show a few representative records for each Companies House data type used by the demo. They are deliberately compact reference examples for readers, not full dossiers or raw API payload dumps.

${sections}
`;
}

function formatReferenceReadme(referenceExamples) {
  return `# Evidence-linked reference examples

${referenceExamples.disclaimer}

This directory contains compact reference examples from the selected FTSE 350 demonstration companies. It is designed for readers who want to see what each Companies House data type looks like without opening a full raw API response.

## Files

- \`reference-examples.json\` is the technical reference pack. Each example includes selected fields plus Companies House evidence metadata.
- \`reference-examples.md\` is the same idea in a reader-friendly table.
- \`index.json\` lists the generated artifacts and selected companies.

## Evidence metadata

Successful source lookups include:

- \`sourceUri\`: the official Companies House API endpoint used.
- \`retrievedAt\`: when the source was retrieved.
- \`payloadSha256\`: a hash of the retrieved source payload.

Unavailable endpoints, such as a 404 insolvency endpoint, are recorded as availability examples with the attempted official endpoint and status code.

These files are examples for software evaluation. They are not legal, accounting, credit, compliance, risk, or investment advice. Public-register data changes, and important facts should be verified directly at Companies House.
`;
}

function buildReferenceIndex(summary, referenceExamples) {
  return {
    schemaVersion: "1.0.0",
    generatedAt: referenceExamples.generatedAt,
    disclaimer,
    artifacts: {
      json: "reference-examples.json",
      markdown: "reference-examples.md",
    },
    companies: summary.selectedCompanies.map((company) => ({
      companyNumber: company.company.companyNumber,
      registeredName: company.company.registeredName,
    })),
  };
}

await mkdir(examplesDirectory, { recursive: true });
await mkdir(referenceDirectory, { recursive: true });

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

const referenceExamples = await buildReferenceExamples(summary, clientContext);
const referenceIndex = buildReferenceIndex(summary, referenceExamples);

await writeFile(
  referenceJsonPath,
  `${JSON.stringify(referenceExamples, null, 2)}\n`,
);
await writeFile(
  referenceIndexPath,
  `${JSON.stringify(referenceIndex, null, 2)}\n`,
);
await writeFile(
  referenceMarkdownPath,
  await formatWithPrettier(formatReferenceMarkdown(referenceExamples), {
    parser: "markdown",
  }),
);
await writeFile(
  referenceReadmePath,
  await formatWithPrettier(formatReferenceReadme(referenceExamples), {
    parser: "markdown",
  }),
);
