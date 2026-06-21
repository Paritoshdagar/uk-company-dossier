import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  companyDossierSchema,
  type CompanyDossier,
} from "../../src/contracts/company-evidence.js";
import { SnapshotError } from "../../src/contracts/errors.js";
import {
  compareDossierSnapshots,
  listDossierSnapshots,
  readDossierSnapshot,
  saveDossierSnapshot,
  snapshotFileNameForDossier,
} from "../../src/snapshots/store.js";

const generatedAt = "2026-06-21T12:00:00.000Z";
const retrievedAt = "2026-06-21T11:59:00.000Z";
const sourceUri =
  "https://api.company-information.service.gov.uk/company/00000006";

function evidenceRef(
  uri: string = sourceUri,
): CompanyDossier["sections"][string]["facts"][number]["evidence"][number] {
  return {
    payloadSha256: "b".repeat(64),
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
      registeredName: "Example Limited",
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
            value: "Example Limited",
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
        warnings: [],
      },
      filing_history: {
        errors: [],
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
            value: "accounts",
          },
        ],
        status: "complete",
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

function withGeneratedAt(
  dossier: CompanyDossier,
  nextGeneratedAt: string,
): CompanyDossier {
  return createDossier({
    ...dossier,
    generatedAt: nextGeneratedAt,
  });
}

async function withSnapshotDir<T>(
  callback: (snapshotDir: string) => Promise<T>,
): Promise<T> {
  const snapshotDir = await mkdtemp(join(tmpdir(), "dossier-snapshots-"));

  try {
    return await callback(snapshotDir);
  } finally {
    await rm(snapshotDir, { force: true, recursive: true });
  }
}

describe("snapshot file names", () => {
  it("uses stable company-number and RFC3339-safe generated-time file names", () => {
    expect(snapshotFileNameForDossier(createDossier())).toBe(
      "00000006--2026-06-21T12-00-00.000Z.json",
    );
  });
});

describe("snapshot store save", () => {
  it("requires an explicit snapshot directory and writes inspectable schema-valid JSON", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const dossier = createDossier();
      const saved = await saveDossierSnapshot({ dossier, snapshotDir });
      const savedText = await readFile(saved.path, "utf8");

      expect(saved.fileName).toBe("00000006--2026-06-21T12-00-00.000Z.json");
      expect(JSON.parse(savedText)).toEqual(dossier);
      expect(savedText.endsWith("\n")).toBe(true);
    });
  });

  it("refuses collisions without replacing the existing snapshot", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const original = createDossier();
      const changed = createDossier({
        sections: {
          ...original.sections,
          company_profile: {
            ...original.sections.company_profile,
            facts: [
              {
                ...original.sections.company_profile.facts[0],
                value: "Changed Limited",
              },
            ],
          },
        },
      });
      const saved = await saveDossierSnapshot({
        dossier: original,
        snapshotDir,
      });
      const beforeCollision = await readFile(saved.path, "utf8");

      await expect(
        saveDossierSnapshot({ dossier: changed, snapshotDir }),
      ).rejects.toThrow(SnapshotError);
      await expect(readFile(saved.path, "utf8")).resolves.toBe(beforeCollision);
    });
  });

  it("keeps atomic writes complete under concurrent same-name saves", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const dossier = createDossier();
      const results = await Promise.allSettled([
        saveDossierSnapshot({ dossier, snapshotDir }),
        saveDossierSnapshot({ dossier, snapshotDir }),
      ]);
      const fulfilled = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof saveDossierSnapshot>>
        > => result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      const entries = await readdir(snapshotDir);
      const savedText = await readFile(fulfilled[0]?.value.path ?? "", "utf8");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(SnapshotError);
      expect(entries).toEqual([snapshotFileNameForDossier(dossier)]);
      expect(
        companyDossierSchema.safeParse(JSON.parse(savedText)).success,
      ).toBe(true);
    });
  });

  it("validates the dossier schema before saving", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const invalidDossier = {
        ...createDossier(),
        company: {
          companyNumber: "bad",
        },
      } as unknown as CompanyDossier;

      await expect(
        saveDossierSnapshot({ dossier: invalidDossier, snapshotDir }),
      ).rejects.toThrow(SnapshotError);
      await expect(readdir(snapshotDir)).resolves.toEqual([]);
    });
  });
});

describe("snapshot store path confinement", () => {
  it("rejects empty, relative, absolute, and symlink snapshot reads", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const outsidePath = join(snapshotDir, "..", "outside-dossier.json");
      await writeFile(outsidePath, "{}", "utf8");
      await symlink(outsidePath, join(snapshotDir, "linked.json"));

      await expect(
        readDossierSnapshot({ fileName: "", snapshotDir }),
      ).rejects.toThrow(SnapshotError);
      await expect(
        readDossierSnapshot({
          fileName: "../outside-dossier.json",
          snapshotDir,
        }),
      ).rejects.toThrow(SnapshotError);
      await expect(
        readDossierSnapshot({ fileName: outsidePath, snapshotDir }),
      ).rejects.toThrow(SnapshotError);
      await expect(
        readDossierSnapshot({ fileName: "linked.json", snapshotDir }),
      ).rejects.toThrow(SnapshotError);
    });
  });

  it("rejects untrusted company numbers for list operations", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      await expect(
        listDossierSnapshots({ companyNumber: "../00000006", snapshotDir }),
      ).rejects.toThrow(SnapshotError);
    });
  });
});

describe("snapshot store list and compare", () => {
  it("lists schema-valid snapshots by company number in stable order", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const first = createDossier();
      const second = withGeneratedAt(first, "2026-06-21T13:00:00.000Z");
      const otherCompany = createDossier({
        company: {
          companyNumber: "SC123456",
          registeredName: "Other Limited",
        },
        generatedAt: "2026-06-21T14:00:00.000Z",
      });

      await saveDossierSnapshot({ dossier: second, snapshotDir });
      await saveDossierSnapshot({ dossier: otherCompany, snapshotDir });
      await saveDossierSnapshot({ dossier: first, snapshotDir });

      await expect(
        listDossierSnapshots({ companyNumber: "00000006", snapshotDir }),
      ).resolves.toEqual([
        {
          companyNumber: "00000006",
          fileName: "00000006--2026-06-21T12-00-00.000Z.json",
          generatedAt: "2026-06-21T12:00:00.000Z",
          path: join(snapshotDir, "00000006--2026-06-21T12-00-00.000Z.json"),
        },
        {
          companyNumber: "00000006",
          fileName: "00000006--2026-06-21T13-00-00.000Z.json",
          generatedAt: "2026-06-21T13:00:00.000Z",
          path: join(snapshotDir, "00000006--2026-06-21T13-00-00.000Z.json"),
        },
      ]);
    });
  });

  it("ignores only generated timestamp when comparing otherwise identical snapshots", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const before = createDossier();
      const after = withGeneratedAt(before, "2026-06-21T13:00:00.000Z");
      const beforeSnapshot = await saveDossierSnapshot({
        dossier: before,
        snapshotDir,
      });
      const afterSnapshot = await saveDossierSnapshot({
        dossier: after,
        snapshotDir,
      });

      await expect(
        compareDossierSnapshots({
          afterFileName: afterSnapshot.fileName,
          beforeFileName: beforeSnapshot.fileName,
          snapshotDir,
        }),
      ).resolves.toMatchObject({
        addedFacts: [],
        changedFacts: [],
        hasChanges: false,
        removedFacts: [],
        sectionStatusChanges: [],
      });
    });
  });

  it("reports added, removed, and changed facts plus section status changes", async () => {
    await withSnapshotDir(async (snapshotDir) => {
      const before = createDossier();
      const after = createDossier({
        generatedAt: "2026-06-21T13:00:00.000Z",
        sections: {
          ...before.sections,
          company_profile: {
            ...before.sections.company_profile,
            facts: [
              {
                ...before.sections.company_profile.facts[0],
                value: "Changed Limited",
              },
              {
                evidence: [evidenceRef()],
                id: "company-profile.status",
                origin: "source",
                type: "company.status",
                value: "active",
              },
            ],
            status: "partial",
            warnings: ["The company profile changed between snapshots."],
          },
        },
      });
      const beforeSnapshot = await saveDossierSnapshot({
        dossier: before,
        snapshotDir,
      });
      const afterSnapshot = await saveDossierSnapshot({
        dossier: after,
        snapshotDir,
      });
      const comparison = await compareDossierSnapshots({
        afterFileName: afterSnapshot.fileName,
        beforeFileName: beforeSnapshot.fileName,
        snapshotDir,
      });

      expect(comparison.hasChanges).toBe(true);
      expect(comparison.addedFacts).toEqual([
        expect.objectContaining({
          factId: "company-profile.status",
          sectionKey: "company_profile",
        }),
      ]);
      expect(comparison.removedFacts).toEqual([
        expect.objectContaining({
          factId: "company-profile.number",
          sectionKey: "company_profile",
        }),
      ]);
      expect(comparison.changedFacts).toHaveLength(1);
      expect(comparison.changedFacts[0]?.factId).toBe("company-profile.name");
      expect(comparison.changedFacts[0]?.sectionKey).toBe("company_profile");
      expect(comparison.changedFacts[0]?.after.value).toBe("Changed Limited");
      expect(comparison.changedFacts[0]?.before.value).toBe("Example Limited");
      expect(comparison.sectionStatusChanges).toEqual([
        {
          afterStatus: "partial",
          beforeStatus: "complete",
          sectionKey: "company_profile",
        },
      ]);
    });
  });
});
