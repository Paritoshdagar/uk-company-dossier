import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareRankedCompanyRecords,
  formatRandomSelectionManifest,
  selectRandomCompanies,
  validateRandomSelectionPolicy,
  type RandomPickerCandidateSnapshot,
  type RandomSelectionPolicy,
  type RandomSelectionStratum,
} from "../../src/examples/random-picker.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const seed = "public-demo-v1";

async function readJsonFile<T>(pathSegments: string[]): Promise<T> {
  return JSON.parse(
    await readFile(join(repositoryRoot, ...pathSegments), "utf8"),
  ) as T;
}

async function loadInputs(): Promise<{
  policy: RandomSelectionPolicy;
  snapshot: RandomPickerCandidateSnapshot;
}> {
  const snapshot = await readJsonFile<RandomPickerCandidateSnapshot>([
    "tests",
    "fixtures",
    "random-picker",
    "candidates.json",
  ]);
  const policy = await readJsonFile<RandomSelectionPolicy>([
    "examples",
    "random-selection",
    "selection-policy.json",
  ]);

  return { policy, snapshot };
}

function independentCanonicalCompanyNumber(value: string): string | undefined {
  const normalised = value.trim().toUpperCase();

  if (/^[0-9]{1,8}$/.test(normalised)) {
    return normalised.padStart(8, "0");
  }

  if (/^[A-Z]{2}[0-9]{6}$/.test(normalised)) {
    return normalised;
  }

  return undefined;
}

function independentRankHash(companyNumber: string): string {
  return createHash("sha256")
    .update(seed)
    .update("\0")
    .update(companyNumber)
    .digest("hex");
}

function stratumByName(
  policy: RandomSelectionPolicy,
): Map<string, RandomSelectionStratum> {
  return new Map(policy.strata.map((stratum) => [stratum.name, stratum]));
}

describe("random company example picker", () => {
  it("rejects ineligible records and selects the declared count from each predeclared stratum", async () => {
    const { policy, snapshot } = await loadInputs();
    const validatedPolicy = validateRandomSelectionPolicy(policy);
    const manifest = selectRandomCompanies(snapshot, validatedPolicy, seed);
    const policyStrata = stratumByName(validatedPolicy);
    const expectedEligible = snapshot.candidates
      .map((candidate) => ({
        candidate,
        companyNumber: independentCanonicalCompanyNumber(
          candidate.companyNumber,
        ),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          candidate: (typeof snapshot.candidates)[number];
          companyNumber: string;
        } => candidate.companyNumber !== undefined,
      )
      .filter(({ candidate }) => policyStrata.has(candidate.eligibilityPool))
      .filter(({ candidate }) => candidate.companyStatus !== undefined)
      .filter(
        ({ candidate }) =>
          candidate.companyStatus ===
          policyStrata.get(candidate.eligibilityPool)?.companyStatus,
      )
      .filter(
        ({ companyNumber }, index, candidates) =>
          candidates.findIndex(
            (candidate) => candidate.companyNumber === companyNumber,
          ) === index,
      );

    const expectedSelected = validatedPolicy.strata.flatMap((stratum) =>
      expectedEligible
        .filter(({ candidate }) => candidate.eligibilityPool === stratum.name)
        .map(({ candidate, companyNumber }) => ({
          companyNumber,
          eligibilityPool: candidate.eligibilityPool,
          hash: independentRankHash(companyNumber),
          snapshotDate: candidate.snapshotDate,
          snapshotSource: candidate.snapshotSource,
        }))
        .sort(
          (left, right) =>
            left.hash.localeCompare(right.hash) ||
            left.companyNumber.localeCompare(right.companyNumber),
        )
        .slice(0, stratum.count)
        .map((candidate, index) => ({
          ...candidate,
          rank: index + 1,
          selectionStatus: "selected" as const,
        })),
    );

    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.seed).toBe(seed);
    expect(manifest.algorithm).toEqual({
      hash: "sha256",
      input: 'seed + "\\0" + canonicalCompanyNumber',
      name: "company-dossier-random-picker",
      sort: "hash ascending, companyNumber ascending",
      version: "1.0.0",
    });
    expect(manifest.snapshot).toEqual({
      date: snapshot.snapshotDate,
      sha256: snapshot.snapshotSha256,
      uri: snapshot.snapshotUri,
    });
    expect(manifest.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.selectedRecords).toEqual(expectedSelected);
    expect(manifest.selectedRecords).toHaveLength(3);
    expect(
      manifest.selectedRecords.some((record) =>
        Object.hasOwn(record, "manualOverride"),
      ),
    ).toBe(false);
    expect(manifest.rejectedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          companyNumber: "00000002",
          inputCompanyNumber: "00000002",
          reason: "duplicate-company-number",
        }),
        expect.objectContaining({
          inputCompanyNumber: "00000005",
          reason: "outside-eligibility-strata",
        }),
        expect.objectContaining({
          inputCompanyNumber: "not-a-number",
          reason: "invalid-company-number",
        }),
        expect.objectContaining({
          companyNumber: "00000006",
          inputCompanyNumber: "00000006",
          reason: "missing-company-status",
        }),
      ]),
    );
  });

  it("renders the same manifest bytes for the same snapshot, policy, and seed", async () => {
    const { policy, snapshot } = await loadInputs();
    const validatedPolicy = validateRandomSelectionPolicy(policy);
    const first = formatRandomSelectionManifest(
      selectRandomCompanies(snapshot, validatedPolicy, seed),
    );
    const second = formatRandomSelectionManifest(
      selectRandomCompanies(snapshot, validatedPolicy, seed),
    );

    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
  });

  it("sorts hash collisions by canonical company number", () => {
    expect(
      compareRankedCompanyRecords(
        { companyNumber: "00000002", hash: "abc" },
        { companyNumber: "00000001", hash: "abc" },
      ),
    ).toBeGreaterThan(0);
  });

  it("rejects manual override policy fields instead of supporting hand-picking", async () => {
    const { policy } = await loadInputs();

    expect(() =>
      validateRandomSelectionPolicy({
        ...policy,
        manualOverrides: ["00000001"],
      }),
    ).toThrow(/manual override/i);
  });
});
