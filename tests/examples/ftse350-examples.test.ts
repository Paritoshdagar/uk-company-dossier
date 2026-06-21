import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const disclaimer =
  "Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.";
const referenceSections = [
  "charges",
  "filings",
  "insolvency",
  "officers",
  "profile",
  "pscs",
] as const;

interface SelectionManifest {
  readonly selectedRecords: readonly {
    readonly companyNumber: string;
    readonly selectionStatus: string;
  }[];
}

interface LiveSummary {
  readonly disclaimer: string;
  readonly selectedCompanies: readonly {
    readonly company: {
      readonly companyNumber: string;
      readonly registeredName: string;
      readonly status: string;
    };
    readonly sections: Record<string, unknown>;
  }[];
}

interface ReferenceExamples {
  readonly disclaimer: string;
  readonly examplesByType: Record<
    (typeof referenceSections)[number],
    readonly {
      readonly company: {
        readonly companyNumber: string;
        readonly registeredName: string;
      };
      readonly evidence: readonly {
        readonly payloadSha256?: string;
        readonly retrievedAt: string;
        readonly sourceUri: string;
        readonly statusCode?: number;
      }[];
      readonly fields: Record<string, string | number | boolean | null>;
      readonly note?: string;
      readonly type: string;
    }[]
  >;
  readonly generatedAt: string;
  readonly source: {
    readonly companiesHouseApiBaseUri: string;
    readonly selectionManifest: string;
  };
}

interface ReferenceExampleIndex {
  readonly artifacts: {
    readonly json: string;
    readonly markdown: string;
  };
  readonly companies: readonly {
    readonly companyNumber: string;
    readonly registeredName: string;
  }[];
  readonly disclaimer: string;
  readonly generatedAt: string;
}

async function readExampleJson<T>(fileName: string): Promise<T> {
  return JSON.parse(
    await readFile(
      join(repositoryRoot, "examples", "ftse350", fileName),
      "utf8",
    ),
  ) as T;
}

async function readReferenceJson<T>(fileName: string): Promise<T> {
  return JSON.parse(
    await readFile(
      join(repositoryRoot, "examples", "ftse350", "reference", fileName),
      "utf8",
    ),
  ) as T;
}

function expectPublicSafeText(label: string, text: string): void {
  const privateTermsPattern = new RegExp(
    [
      ["hind", "sight"].join(""),
      ["codebase", "memory"].join("-"),
      ["Project", "Phoenix"].join(""),
      ["FCom", "HouseAPI"].join(""),
      ["docs", "superpowers"].join("/"),
    ].join("|"),
    "iu",
  );

  expect(text, label).not.toMatch(
    /Authorization\s*[:=]|COMPANIES_HOUSE_API_KEY\s*=|api[-_]?key\s*[:=]|gho_[A-Za-z0-9_]+/iu,
  );
  expect(text, label).not.toMatch(
    /\/Users\/|\/home\/[^/\s]+\/(?:Documents|Desktop|Downloads)|[A-Z]:\\Users\\/u,
  );
  expect(text, label).not.toMatch(privateTermsPattern);
}

function expectOfficialEvidenceUris(
  evidenceRefs: readonly ReferenceExamples["examplesByType"]["profile"][number]["evidence"][number][],
): void {
  expect(evidenceRefs.length).toBeGreaterThan(0);

  for (const evidence of evidenceRefs) {
    const sourceUrl = new URL(evidence.sourceUri);

    expect(sourceUrl.protocol, evidence.sourceUri).toBe("https:");
    expect(
      [
        "api.company-information.service.gov.uk",
        "developer.company-information.service.gov.uk",
        "find-and-update.company-information.service.gov.uk",
        "www.gov.uk",
      ],
      evidence.sourceUri,
    ).toContain(sourceUrl.hostname);
    if (evidence.payloadSha256 !== undefined) {
      expect(evidence.payloadSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(evidence.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  }
}

describe("FTSE 350 public examples", () => {
  it("keeps deterministic selection and live summary aligned", async () => {
    const manifest = await readExampleJson<SelectionManifest>(
      "selection-manifest.json",
    );
    const summary = await readExampleJson<LiveSummary>("live-summary.json");
    const selectedNumbers = manifest.selectedRecords.map(
      (record) => record.companyNumber,
    );

    expect(manifest.selectedRecords).toHaveLength(5);
    expect(
      manifest.selectedRecords.every(
        (record) => record.selectionStatus === "selected",
      ),
    ).toBe(true);
    expect(
      summary.selectedCompanies.map((entry) => entry.company.companyNumber),
    ).toEqual(selectedNumbers);
  });

  it("keeps live summaries compact and safe for public examples", async () => {
    const summary = await readExampleJson<LiveSummary>("live-summary.json");
    const markdown = await readFile(
      join(repositoryRoot, "examples", "ftse350", "live-summary.md"),
      "utf8",
    );

    expect(summary.disclaimer).toBe(disclaimer);
    expect(markdown).toContain(disclaimer);
    expect(markdown).not.toContain("undefined");
    expect(markdown).not.toMatch(
      /Authorization\s*[:=]|COMPANIES_HOUSE_API_KEY\s*=/u,
    );

    for (const entry of summary.selectedCompanies) {
      expect(entry.company.registeredName).toMatch(/\S/u);
      expect(entry.company.status).toBe("active");
      expect(Object.keys(entry.sections).sort()).toEqual([
        "charges",
        "filings",
        "insolvency",
        "officers",
        "profile",
        "pscs",
      ]);
      expect(JSON.stringify(entry)).not.toMatch(
        /officer_name|appointed_on|address_line|etag|"\s*links"\s*:|"\s*items"\s*:/u,
      );
    }
  });

  it("commits compact evidence-linked reference examples for each data type", async () => {
    const summary = await readExampleJson<LiveSummary>("live-summary.json");
    const index = await readReferenceJson<ReferenceExampleIndex>("index.json");
    const referenceExamples = await readReferenceJson<ReferenceExamples>(
      "reference-examples.json",
    );
    const readme = await readFile(
      join(repositoryRoot, "examples", "ftse350", "reference", "README.md"),
      "utf8",
    );
    const markdown = await readFile(
      join(
        repositoryRoot,
        "examples",
        "ftse350",
        "reference",
        "reference-examples.md",
      ),
      "utf8",
    );

    expect(index.disclaimer).toBe(disclaimer);
    expect(index.companies).toHaveLength(5);
    expect(index.artifacts).toEqual({
      json: "reference-examples.json",
      markdown: "reference-examples.md",
    });
    expect(referenceExamples.disclaimer).toBe(disclaimer);
    expect(Object.keys(referenceExamples.examplesByType).sort()).toEqual([
      ...referenceSections,
    ]);
    expect(readme).toContain(disclaimer);
    expect(readme).toContain("Evidence-linked reference examples");
    expect(markdown).toContain("Evidence-linked reference examples");
    expect(markdown).toContain("Companies House source");
    expectPublicSafeText("dossier README", readme);
    expectPublicSafeText("reference markdown", markdown);
    expectPublicSafeText(
      "reference examples JSON",
      JSON.stringify(referenceExamples),
    );
    expect(index.companies.map((company) => company.companyNumber)).toEqual(
      summary.selectedCompanies.map((entry) => entry.company.companyNumber),
    );

    for (const section of referenceSections) {
      const examples = referenceExamples.examplesByType[section];

      expect(examples.length, section).toBeGreaterThan(0);
      expect(examples.length, section).toBeLessThanOrEqual(3);

      for (const example of examples) {
        expect(
          summary.selectedCompanies.map((entry) => entry.company.companyNumber),
        ).toContain(example.company.companyNumber);
        expect(example.company.registeredName).toMatch(/\S/u);
        expect(example.type).toBe(section);
        expect(Object.keys(example.fields).length, section).toBeGreaterThan(0);
        expect(JSON.stringify(example.fields), section).not.toMatch(
          /"\s*(etag|links|items|address_line_1|address_line_2)"\s*:/iu,
        );
        expectOfficialEvidenceUris(example.evidence);
      }
    }

    for (const company of index.companies) {
      expect(company.registeredName).toMatch(/\S/u);
    }
  });
});
