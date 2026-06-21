import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ValidateFunction } from "ajv";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  companyDossierSchema,
  type CompanyDossier,
} from "../../src/contracts/company-evidence.js";
import { renderCompanyDossierJson } from "../../src/renderers/json-renderer.js";
import { renderCompanyDossierMarkdown } from "../../src/renderers/markdown-renderer.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const schemaPath = join(
  repositoryRoot,
  "schemas",
  "company-evidence.schema.json",
);
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;

const retrievedAt = "2026-06-21T11:59:00.000Z";
const generatedAt = "2026-06-21T12:00:00.000Z";
const sourceUri =
  "https://api.company-information.service.gov.uk/company/00000006";

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateSchema: true,
  });

  addFormats(ajv);

  return ajv;
}

async function loadDossierJsonValidator(): Promise<
  ValidateFunction<CompanyDossier>
> {
  const ajv = createAjv();
  const jsonSchema = JSON.parse(
    await readFile(schemaPath, "utf8"),
  ) as AnySchema;

  expect(ajv.validateSchema(jsonSchema), ajv.errorsText()).toBe(true);

  return ajv.compile<CompanyDossier>(jsonSchema);
}

function evidenceRef(
  uri: string = sourceUri,
): CompanyDossier["sections"][string]["facts"][number]["evidence"][number] {
  return {
    payloadSha256: "a".repeat(64),
    retrievedAt,
    sourceUri: uri,
  };
}

function createDossier(
  overrides: Partial<CompanyDossier> = {},
): CompanyDossier {
  return companyDossierSchema.parse({
    company: {
      companyNumber: "00000006",
      registeredName: "ACME <script>|[x]_ LTD",
    },
    generatedAt,
    schemaVersion: "1.0.0",
    sections: {
      company_profile: {
        errors: [],
        facts: [
          {
            evidence: [evidenceRef()],
            id: "company-profile.name",
            origin: "source",
            type: "company.name",
            value: "ACME <script>|[x]_ LTD",
          },
          {
            evidence: [evidenceRef()],
            id: "company-profile.number",
            origin: "source",
            type: "company.number",
            value: "00000006",
          },
        ],
        status: "complete",
        warnings: ["Name contains upstream characters: <script>|[x]_"],
      },
      filing_history: {
        errors: ["Companies House returned & delayed"],
        facts: [
          {
            evidence: [
              evidenceRef(
                "https://api.company-information.service.gov.uk/company/00000006/filing-history",
              ),
            ],
            id: "filing-history.last-filing",
            origin: "source",
            type: "filing-history.last-filing",
            value: {
              category: "accounts",
              description: "Accounts <b>filed</b>",
            },
          },
        ],
        status: "partial",
        warnings: ["Some filings could not be loaded <b>late</b>"],
      },
      insolvency: {
        errors: [],
        facts: [],
        status: "not_applicable",
        warnings: ["No insolvency data <none>"],
      },
      charges: {
        errors: ["Endpoint unavailable <timeout>"],
        facts: [],
        status: "unavailable",
        warnings: [],
      },
    },
    sourceAttribution: {
      dataTermsUri: "https://developer.company-information.service.gov.uk",
      licenceUri:
        "https://www.gov.uk/government/publications/companies-house-accreditation-to-information-fair-traders-scheme",
      nonAffiliationStatement:
        "This report is not affiliated with or endorsed by Companies House.",
      provider: "Companies House",
      retrievalCaveat:
        "Retrieved at generation time. Sources may change after retrieval.",
      sourceUri: "https://api.company-information.service.gov.uk",
    },
    ...overrides,
  });
}

describe("JSON dossier renderer", () => {
  it("renders schema-valid deterministic JSON with exactly one trailing newline", async () => {
    const validator = await loadDossierJsonValidator();
    const dossier = createDossier();
    const reorderedDossier = createDossier({
      sections: {
        insolvency: dossier.sections.insolvency,
        filing_history: dossier.sections.filing_history,
        company_profile: dossier.sections.company_profile,
        charges: dossier.sections.charges,
      },
    });

    const rendered = renderCompanyDossierJson(dossier);
    const reorderedRendered = renderCompanyDossierJson(reorderedDossier);
    const parsed = JSON.parse(rendered) as CompanyDossier;

    expect(rendered).toBe(reorderedRendered);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    expect(validator(parsed), JSON.stringify(validator.errors)).toBe(true);
    expect(companyDossierSchema.safeParse(parsed).success).toBe(true);
    expect(rendered.indexOf('"charges"')).toBeLessThan(
      rendered.indexOf('"company_profile"'),
    );
    expect(rendered.indexOf('"company_profile"')).toBeLessThan(
      rendered.indexOf('"filing_history"'),
    );
    expect(rendered.indexOf('"filing_history"')).toBeLessThan(
      rendered.indexOf('"insolvency"'),
    );
  });
});

describe("Markdown dossier renderer", () => {
  it("renders escaped human-readable evidence with attribution and disclaimer", () => {
    const markdown = renderCompanyDossierMarkdown(createDossier());

    expect(markdown).toContain("00000006");
    expect(markdown).toContain(generatedAt);
    expect(markdown).toContain("Status: complete");
    expect(markdown).toContain("Status: partial");
    expect(markdown).toContain("Status: unavailable");
    expect(markdown).toContain("Status: not_applicable");
    expect(markdown).toContain("Warnings");
    expect(markdown).toContain("Errors");
    expect(markdown).toContain("Companies House returned &amp; delayed");
    expect(markdown).toContain(`[Source 1](${sourceUri})`);
    expect(markdown).toContain("Companies House");
    expect(markdown).toContain(
      "not legal, financial, accounting, or investment advice",
    );
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("\\|");
    expect(markdown).toContain("\\[x\\]");
    expect(markdown).toContain("\\_");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("<b>");
    expect(markdown).not.toContain("</b>");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});
