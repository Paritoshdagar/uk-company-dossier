import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareRankedCompanyRecords,
  formatRandomSelectionManifest,
  selectRandomCompanies,
  validateRandomPickerCandidateSnapshot,
  validateRandomSelectionPolicy,
  type RandomPickerCandidate,
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
  const snapshot = validateRandomPickerCandidateSnapshot(
    await readJsonFile<unknown>([
      "tests",
      "fixtures",
      "random-picker",
      "candidates.json",
    ]),
  );
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

function firstCandidate(
  snapshot: RandomPickerCandidateSnapshot,
): RandomPickerCandidate {
  const candidate = snapshot.candidates[0];

  if (candidate === undefined) {
    throw new Error("Fixture snapshot must contain at least one candidate.");
  }

  return candidate;
}

function withTopRankedPrivateCandidateFailure(
  snapshot: RandomPickerCandidateSnapshot,
  policy: RandomSelectionPolicy,
): RandomPickerCandidateSnapshot {
  const privateStratum = stratumByName(policy).get("active-private-company");

  if (privateStratum === undefined) {
    throw new Error("Fixture policy must include active-private-company.");
  }

  const topRankedPrivateCandidate = snapshot.candidates
    .filter(
      (candidate) =>
        candidate.eligibilityPool === privateStratum.name &&
        candidate.companyStatus === privateStratum.companyStatus,
    )
    .map((candidate) => ({
      candidate,
      companyNumber: independentCanonicalCompanyNumber(candidate.companyNumber),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        candidate: RandomPickerCandidate;
        companyNumber: string;
      } => candidate.companyNumber !== undefined,
    )
    .sort(
      (left, right) =>
        independentRankHash(left.companyNumber).localeCompare(
          independentRankHash(right.companyNumber),
        ) || left.companyNumber.localeCompare(right.companyNumber),
    )[0];

  if (topRankedPrivateCandidate === undefined) {
    throw new Error("Fixture snapshot must contain an active private company.");
  }

  return {
    ...snapshot,
    candidates: snapshot.candidates.map((candidate) =>
      independentCanonicalCompanyNumber(candidate.companyNumber) ===
      topRankedPrivateCandidate.companyNumber
        ? {
            ...candidate,
            retrievalFailure: {
              message: "Synthetic document retrieval failure.",
              reason: "document-unavailable",
            },
          }
        : candidate,
    ),
  };
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

  it("throws a stratum-specific error when eligible candidates cannot satisfy the declared count", async () => {
    const { policy, snapshot } = await loadInputs();
    const validatedPolicy = validateRandomSelectionPolicy({
      ...policy,
      strata: policy.strata.map((stratum) =>
        stratum.name === "active-private-company"
          ? { ...stratum, count: 4 }
          : stratum,
      ),
    });

    expect(() =>
      selectRandomCompanies(snapshot, validatedPolicy, seed),
    ).toThrow(
      /active-private-company.*declared count 4.*successful selections 3/i,
    );
  });

  it("retains a top-ranked retrieval failure and selects the next ranked candidate", async () => {
    const { policy, snapshot } = await loadInputs();
    const validatedPolicy = validateRandomSelectionPolicy(policy);
    const manifest = selectRandomCompanies(
      withTopRankedPrivateCandidateFailure(snapshot, validatedPolicy),
      validatedPolicy,
      seed,
    );
    const privateSelections = manifest.selectedRecords.filter(
      (record) => record.eligibilityPool === "active-private-company",
    );

    expect(privateSelections).toHaveLength(2);
    expect(privateSelections[0]).toEqual(
      expect.objectContaining({
        retrievalFailure: {
          message: "Synthetic document retrieval failure.",
          reason: "document-unavailable",
        },
        selectionStatus: "retrieval_failed",
      }),
    );
    expect(privateSelections[1]).toEqual(
      expect.objectContaining({
        selectionStatus: "selected",
      }),
    );
  });

  it("validates candidate snapshots with safe path-specific errors", async () => {
    const snapshot = await readJsonFile<unknown>([
      "tests",
      "fixtures",
      "random-picker",
      "candidates.json",
    ]);
    const validSnapshot = validateRandomPickerCandidateSnapshot(snapshot);
    const candidate = firstCandidate(validSnapshot);

    expect(validSnapshot.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      validateRandomPickerCandidateSnapshot({
        ...validSnapshot,
        snapshotSha256: "not-a-sha256",
      }),
    ).toThrow(/candidate snapshot\.snapshotSha256/i);
    expect(() =>
      validateRandomPickerCandidateSnapshot({
        ...validSnapshot,
        candidates: [{ ...candidate, companyNumber: 123 }],
      }),
    ).toThrow(/candidate snapshot\.candidates\[0\]\.companyNumber/i);
    expect(() =>
      validateRandomPickerCandidateSnapshot({
        ...validSnapshot,
        candidates: [
          {
            ...candidate,
            retrievalFailure: {
              reason: 123,
            },
          },
        ],
      }),
    ).toThrow(/candidate snapshot\.candidates\[0\]\.retrievalFailure\.reason/i);
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
