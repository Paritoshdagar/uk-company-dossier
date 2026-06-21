import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const disclaimer =
  "Demonstration companies were selected programmatically by this repository's documented random-company picker from predeclared Companies House eligibility pools. The author did not choose or rank the selected companies. Inclusion does not imply endorsement, criticism, concern, affiliation, or preference. Public-register information is shown solely to demonstrate software behaviour, may change, and must be verified at Companies House before use.";

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

async function readExampleJson<T>(fileName: string): Promise<T> {
  return JSON.parse(
    await readFile(
      join(repositoryRoot, "examples", "ftse350", fileName),
      "utf8",
    ),
  ) as T;
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
});
