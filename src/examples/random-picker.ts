import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { stableJsonStringify } from "../renderers/json-renderer.js";

const schemaVersion = "1.0.0";
const algorithm = {
  hash: "sha256",
  input: 'seed + "\\0" + canonicalCompanyNumber',
  name: "company-dossier-random-picker",
  sort: "hash ascending, companyNumber ascending",
  version: "1.0.0",
} as const;
const knownRejectionReasons = new Set([
  "invalid-company-number",
  "missing-company-status",
  "duplicate-company-number",
  "outside-eligibility-strata",
  "company-status-mismatch",
]);

export interface RandomPickerCandidate {
  readonly companyNumber: string;
  readonly companyStatus?: string;
  readonly eligibilityPool: string;
  readonly retrievalFailure?: {
    readonly message?: string;
    readonly reason: string;
  };
  readonly snapshotDate: string;
  readonly snapshotSource: string;
}

export interface RandomPickerCandidateSnapshot {
  readonly candidates: readonly RandomPickerCandidate[];
  readonly schemaVersion: string;
  readonly snapshotDate: string;
  readonly snapshotSha256: string;
  readonly snapshotUri: string;
}

export interface RandomSelectionStratum {
  readonly companyStatus: string;
  readonly count: number;
  readonly description: string;
  readonly name: string;
}

export interface RandomSelectionExclusion {
  readonly description: string;
  readonly reason: string;
}

export interface RandomSelectionPolicy {
  readonly algorithm: string;
  readonly exclusions: readonly RandomSelectionExclusion[];
  readonly schemaVersion: string;
  readonly strata: readonly RandomSelectionStratum[];
}

export interface RankedCompanyRecord {
  readonly companyNumber: string;
  readonly eligibilityPool: string;
  readonly hash: string;
  readonly rank: number;
  readonly retrievalFailure?: {
    readonly message?: string;
    readonly reason: string;
  };
  readonly selectionStatus: "retrieval_failed" | "selected";
  readonly snapshotDate: string;
  readonly snapshotSource: string;
}

export interface RejectedCompanyRecord {
  readonly companyNumber?: string;
  readonly detail?: string;
  readonly eligibilityPool?: string;
  readonly inputCompanyNumber: string;
  readonly reason:
    | "company-status-mismatch"
    | "duplicate-company-number"
    | "invalid-company-number"
    | "missing-company-status"
    | "outside-eligibility-strata";
}

export interface RandomSelectionManifest {
  readonly algorithm: typeof algorithm;
  readonly policyHash: string;
  readonly rejectedRecords: readonly RejectedCompanyRecord[];
  readonly schemaVersion: string;
  readonly seed: string;
  readonly selectedRecords: readonly RankedCompanyRecord[];
  readonly snapshot: {
    readonly date: string;
    readonly sha256: string;
    readonly uri: string;
  };
}

interface EligibleCompanyRecord {
  readonly candidate: RandomPickerCandidate;
  readonly companyNumber: string;
  readonly hash: string;
  readonly rank: number;
}

interface ParsedCliArgs {
  readonly candidates: string;
  readonly output: string;
  readonly policy: string;
  readonly seed: string;
}

export function canonicaliseCompanyNumber(value: string): string | undefined {
  const normalised = value.trim().toUpperCase();

  if (/^[0-9]{1,8}$/.test(normalised)) {
    return normalised.padStart(8, "0");
  }

  if (/^[A-Z]{2}[0-9]{6}$/.test(normalised)) {
    return normalised;
  }

  return undefined;
}

export function compareRankedCompanyRecords(
  left: Pick<RankedCompanyRecord, "companyNumber" | "hash">,
  right: Pick<RankedCompanyRecord, "companyNumber" | "hash">,
): number {
  return (
    left.hash.localeCompare(right.hash) ||
    left.companyNumber.localeCompare(right.companyNumber)
  );
}

export function formatRandomSelectionManifest(
  manifest: RandomSelectionManifest,
): string {
  return `${stableJsonStringify(manifest)}\n`;
}

export function rankCompanyNumber(seed: string, companyNumber: string): string {
  return createHash("sha256")
    .update(seed)
    .update("\0")
    .update(companyNumber)
    .digest("hex");
}

export function selectRandomCompanies(
  snapshot: RandomPickerCandidateSnapshot,
  policy: RandomSelectionPolicy,
  seed: string,
): RandomSelectionManifest {
  const strataByName = new Map(
    policy.strata.map((stratum) => [stratum.name, stratum]),
  );
  const seenCompanyNumbers = new Set<string>();
  const rejectedRecords: RejectedCompanyRecord[] = [];
  const eligibleRecords: EligibleCompanyRecord[] = [];

  for (const candidate of snapshot.candidates) {
    const companyNumber = canonicaliseCompanyNumber(candidate.companyNumber);

    if (companyNumber === undefined) {
      rejectedRecords.push({
        eligibilityPool: candidate.eligibilityPool,
        inputCompanyNumber: candidate.companyNumber,
        reason: "invalid-company-number",
      });
      continue;
    }

    if (seenCompanyNumbers.has(companyNumber)) {
      rejectedRecords.push({
        companyNumber,
        eligibilityPool: candidate.eligibilityPool,
        inputCompanyNumber: candidate.companyNumber,
        reason: "duplicate-company-number",
      });
      continue;
    }

    seenCompanyNumbers.add(companyNumber);

    const stratum = strataByName.get(candidate.eligibilityPool);

    if (stratum === undefined) {
      rejectedRecords.push({
        companyNumber,
        eligibilityPool: candidate.eligibilityPool,
        inputCompanyNumber: candidate.companyNumber,
        reason: "outside-eligibility-strata",
      });
      continue;
    }

    if (candidate.companyStatus === undefined) {
      rejectedRecords.push({
        companyNumber,
        eligibilityPool: candidate.eligibilityPool,
        inputCompanyNumber: candidate.companyNumber,
        reason: "missing-company-status",
      });
      continue;
    }

    if (candidate.companyStatus !== stratum.companyStatus) {
      rejectedRecords.push({
        companyNumber,
        detail: `Expected company status ${stratum.companyStatus}; received ${candidate.companyStatus}.`,
        eligibilityPool: candidate.eligibilityPool,
        inputCompanyNumber: candidate.companyNumber,
        reason: "company-status-mismatch",
      });
      continue;
    }

    eligibleRecords.push({
      candidate,
      companyNumber,
      hash: rankCompanyNumber(seed, companyNumber),
      rank: 0,
    });
  }

  const selectedRecords = policy.strata.flatMap((stratum) => {
    const rankedRecords = eligibleRecords
      .filter(({ candidate }) => candidate.eligibilityPool === stratum.name)
      .sort(compareRankedCompanyRecords)
      .map((record, index) => ({
        ...record,
        rank: index + 1,
      }));
    const selectedForStratum: RankedCompanyRecord[] = [];
    let successfulSelections = 0;

    for (const record of rankedRecords) {
      if (successfulSelections >= stratum.count) {
        break;
      }

      selectedForStratum.push({
        companyNumber: record.companyNumber,
        eligibilityPool: record.candidate.eligibilityPool,
        hash: record.hash,
        rank: record.rank,
        ...(record.candidate.retrievalFailure === undefined
          ? {}
          : {
              retrievalFailure: record.candidate.retrievalFailure,
            }),
        selectionStatus:
          record.candidate.retrievalFailure === undefined
            ? "selected"
            : "retrieval_failed",
        snapshotDate: record.candidate.snapshotDate,
        snapshotSource: record.candidate.snapshotSource,
      });

      if (record.candidate.retrievalFailure === undefined) {
        successfulSelections += 1;
      }
    }

    return selectedForStratum;
  });

  return {
    algorithm,
    policyHash: hashStableJson(policy),
    rejectedRecords,
    schemaVersion,
    seed,
    selectedRecords,
    snapshot: {
      date: snapshot.snapshotDate,
      sha256: snapshot.snapshotSha256,
      uri: snapshot.snapshotUri,
    },
  };
}

export function validateRandomSelectionPolicy(
  value: unknown,
): RandomSelectionPolicy {
  assertPlainObject(value, "policy");
  rejectUnknownPolicyKeys(value);
  assertString(value.schemaVersion, "policy.schemaVersion");
  assertString(value.algorithm, "policy.algorithm");
  assertArray(value.strata, "policy.strata");
  assertArray(value.exclusions, "policy.exclusions");

  if (value.schemaVersion !== schemaVersion) {
    throw new Error(
      `Unsupported policy schema version: ${value.schemaVersion}`,
    );
  }

  const stratumNames = new Set<string>();
  const strata = value.strata.map((stratum, index): RandomSelectionStratum => {
    const stratumPath = indexedPath("policy.strata", index);

    assertPlainObject(stratum, stratumPath);
    rejectUnknownKeys(stratum, stratumPath, [
      "companyStatus",
      "count",
      "description",
      "name",
    ]);
    assertString(stratum.name, indexedPath("policy.strata", index, "name"));
    assertString(
      stratum.companyStatus,
      indexedPath("policy.strata", index, "companyStatus"),
    );
    assertPositiveInteger(
      stratum.count,
      indexedPath("policy.strata", index, "count"),
    );
    assertString(
      stratum.description,
      indexedPath("policy.strata", index, "description"),
    );

    if (stratumNames.has(stratum.name)) {
      throw new Error(`Duplicate policy stratum: ${stratum.name}`);
    }

    stratumNames.add(stratum.name);

    return {
      companyStatus: stratum.companyStatus,
      count: stratum.count,
      description: stratum.description,
      name: stratum.name,
    };
  });

  const exclusions = value.exclusions.map(
    (exclusion, index): RandomSelectionExclusion => {
      const exclusionPath = indexedPath("policy.exclusions", index);

      assertPlainObject(exclusion, exclusionPath);
      rejectUnknownKeys(exclusion, exclusionPath, ["description", "reason"]);
      assertString(
        exclusion.reason,
        indexedPath("policy.exclusions", index, "reason"),
      );
      assertString(
        exclusion.description,
        indexedPath("policy.exclusions", index, "description"),
      );

      if (!knownRejectionReasons.has(exclusion.reason)) {
        throw new Error(`Unknown exclusion reason: ${exclusion.reason}`);
      }

      return {
        description: exclusion.description,
        reason: exclusion.reason,
      };
    },
  );

  return {
    algorithm: value.algorithm,
    exclusions,
    schemaVersion: value.schemaVersion,
    strata,
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseCliArgs(argv);
  const [snapshot, policy] = await Promise.all([
    readJsonFile<RandomPickerCandidateSnapshot>(args.candidates),
    readJsonFile<unknown>(args.policy),
  ]);
  const manifest = selectRandomCompanies(
    snapshot,
    validateRandomSelectionPolicy(policy),
    args.seed,
  );

  await writeFile(args.output, formatRandomSelectionManifest(manifest), "utf8");
}

function assertArray(value: unknown, name: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
}

function assertPlainObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
}

function assertPositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function indexedPath(
  collection: string,
  index: number,
  property?: string,
): string {
  const path = `${collection}[${String(index)}]`;

  return property === undefined ? path : `${path}.${property}`;
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === process.argv[1]
  );
}

function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const parsed: Partial<Record<keyof ParsedCliArgs, string>> = {};

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === undefined || value === undefined) {
      throw new Error("Arguments must be provided as --flag value pairs.");
    }

    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected argument: ${flag}`);
    }

    const key = flag.slice(2);

    if (!isCliArgKey(key)) {
      throw new Error(`Unknown argument: ${flag}`);
    }

    parsed[key] = value;
  }

  for (const key of ["candidates", "output", "policy", "seed"] as const) {
    if (parsed[key] === undefined) {
      throw new Error(`Missing required argument: --${key}`);
    }
  }

  return {
    candidates: requiredCliArg(parsed, "candidates"),
    output: requiredCliArg(parsed, "output"),
    policy: requiredCliArg(parsed, "policy"),
    seed: requiredCliArg(parsed, "seed"),
  };
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function rejectUnknownPolicyKeys(value: Record<string, unknown>): void {
  rejectUnknownKeys(value, "policy", [
    "algorithm",
    "exclusions",
    "schemaVersion",
    "strata",
  ]);
}

function requiredCliArg(
  parsed: Partial<Record<keyof ParsedCliArgs, string>>,
  key: keyof ParsedCliArgs,
): string {
  const value = parsed[key];

  if (value === undefined) {
    throw new Error(`Missing required argument: --${key}`);
  }

  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  name: string,
  allowedKeys: readonly string[],
): void {
  const allowedKeySet = new Set(allowedKeys);
  const unknownKey = Object.keys(value).find((key) => !allowedKeySet.has(key));

  if (unknownKey === undefined) {
    return;
  }

  if (unknownKey.toLowerCase().includes("manual")) {
    throw new Error(`Manual override policy fields are not supported.`);
  }

  throw new Error(`${name} includes unknown key: ${unknownKey}`);
}

function isCliArgKey(value: string): value is keyof ParsedCliArgs {
  return ["candidates", "output", "policy", "seed"].includes(value);
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
