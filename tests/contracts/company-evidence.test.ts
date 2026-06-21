import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ValidateFunction } from "ajv";
import * as addFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  companyDossierSchema,
  createFactSchema,
  evidenceRefSchema,
  evidenceSectionSchema,
  evidenceStatusSchema,
  jsonValueSchema,
  type CompanyDossier,
  type EvidenceStatus,
} from "../../src/contracts/company-evidence.js";
import {
  CompaniesHouseHttpError,
  ConfigurationError,
  DocumentSafetyError,
  RateLimitError,
  ResourceNotFoundError,
  SnapshotError,
  redactSecretText,
} from "../../src/contracts/errors.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturesRoot = join(repositoryRoot, "tests", "fixtures", "contracts");
const validFixturesRoot = join(fixturesRoot, "valid");
const invalidFixturesRoot = join(fixturesRoot, "invalid");
const schemaPath = join(
  repositoryRoot,
  "schemas",
  "company-evidence.schema.json",
);
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function loadJsonFile(path: string): Promise<unknown> {
  return parseJson(await readFile(path, "utf8"));
}

async function loadFixtureCases(
  directory: string,
): Promise<readonly (readonly [string, unknown])[]> {
  const entries = await readdir(directory);
  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort();

  return Promise.all(
    jsonFiles.map(async (fileName) => [
      fileName,
      await loadJsonFile(join(directory, fileName)),
    ]),
  );
}

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
  const jsonSchema = (await loadJsonFile(schemaPath)) as AnySchema;

  expect(ajv.validateSchema(jsonSchema), ajv.errorsText()).toBe(true);

  return ajv.compile<CompanyDossier>(jsonSchema);
}

function expectZodAccepts(value: unknown): void {
  const result = companyDossierSchema.safeParse(value);

  if (!result.success) {
    throw new Error(result.error.message);
  }
}

function expectJsonSchemaAccepts(
  validator: ValidateFunction<CompanyDossier>,
  value: unknown,
): void {
  const result = validator(value);

  if (!result) {
    throw new Error(
      `JSON Schema rejected fixture: ${JSON.stringify(validator.errors)}`,
    );
  }
}

const validEvidenceRef = {
  sourceUri: "https://api.company-information.service.gov.uk/company/00000006",
  retrievedAt: "2026-06-21T10:29:00Z",
  payloadSha256: "a".repeat(64),
};

const validSourceFact = {
  id: "company-profile.number",
  type: "company.number",
  origin: "source",
  value: "00000006",
  evidence: [validEvidenceRef],
};

describe("company evidence contract fixtures", () => {
  it("self-validates the public JSON Schema document", async () => {
    const ajv = createAjv();
    const jsonSchema = (await loadJsonFile(schemaPath)) as AnySchema;

    expect(ajv.validateSchema(jsonSchema), ajv.errorsText()).toBe(true);
  });

  it("accepts every valid fixture with both Zod and Ajv", async () => {
    const validator = await loadDossierJsonValidator();
    const cases = await loadFixtureCases(validFixturesRoot);

    expect(cases.length).toBeGreaterThan(0);

    for (const [fileName, fixture] of cases) {
      expectZodAccepts(fixture);
      expectJsonSchemaAccepts(validator, fixture);
      expect(fileName).toMatch(/\.json$/);
    }
  });

  it("rejects every invalid fixture with both Zod and Ajv", async () => {
    const validator = await loadDossierJsonValidator();
    const cases = await loadFixtureCases(invalidFixturesRoot);

    expect(cases.length).toBeGreaterThan(0);

    for (const [fileName, fixture] of cases) {
      const zodResult = companyDossierSchema.safeParse(fixture);
      const ajvResult = validator(fixture);

      expect(zodResult.success, `${fileName} should fail Zod`).toBe(false);
      expect(ajvResult, `${fileName} should fail Ajv`).toBe(false);
    }
  });
});

describe("company evidence Zod contract", () => {
  it("allows only the four honest evidence statuses", () => {
    const statuses: EvidenceStatus[] = [
      "complete",
      "partial",
      "unavailable",
      "not_applicable",
    ];

    expect(
      statuses.map((status) => evidenceStatusSchema.parse(status)),
    ).toEqual(statuses);
    expect(evidenceStatusSchema.safeParse("pending").success).toBe(false);
  });

  it("requires strict HTTPS evidence references with RFC3339 time and lowercase SHA-256", () => {
    expect(evidenceRefSchema.safeParse(validEvidenceRef).success).toBe(true);

    for (const invalid of [
      {
        ...validEvidenceRef,
        sourceUri: "http://api.company-information.service.gov.uk/company/1",
      },
      { ...validEvidenceRef, retrievedAt: "2026-06-21 10:29:00" },
      { ...validEvidenceRef, payloadSha256: "A".repeat(64) },
      { ...validEvidenceRef, documentId: " " },
      { ...validEvidenceRef, extra: true },
    ]) {
      expect(evidenceRefSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("enforces source and derived fact origin semantics through the generic fact schema", () => {
    const stringFactSchema = createFactSchema(z.string().min(1));
    const validDerivedFact = {
      ...validSourceFact,
      id: "company-profile.normalized-number",
      type: "company.normalized_number",
      origin: "derived",
      ruleId: "rule.company-number-normalization.v1",
    };

    expect(stringFactSchema.safeParse(validSourceFact).success).toBe(true);
    expect(stringFactSchema.safeParse(validDerivedFact).success).toBe(true);
    expect(
      stringFactSchema.safeParse({ ...validSourceFact, ruleId: "rule.v1" })
        .success,
    ).toBe(false);
    expect(
      stringFactSchema.safeParse({
        ...validDerivedFact,
        ruleId: undefined,
      }).success,
    ).toBe(false);
    expect(
      stringFactSchema.safeParse({ ...validSourceFact, value: 42 }).success,
    ).toBe(false);
  });

  it("keeps fact values JSON-compatible", () => {
    const validValues: unknown[] = [
      null,
      true,
      42,
      "text",
      ["nested", 1, false, null],
      { nested: { array: [1, "two", null] } },
    ];

    for (const value of validValues) {
      expect(
        jsonValueSchema.safeParse(value).success,
        `expected JSON value ${JSON.stringify(value)} to pass`,
      ).toBe(true);
    }

    expect(jsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(
      false,
    );
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(() => "not json").success).toBe(false);
  });

  it("preserves status semantics so incomplete sections cannot look complete", () => {
    const completeSection = {
      status: "complete",
      facts: [validSourceFact],
      warnings: [],
      errors: [],
    };
    const notApplicableSection = {
      status: "not_applicable",
      facts: [],
      warnings: ["No data is applicable for this section."],
      errors: [],
    };

    expect(evidenceSectionSchema.safeParse(completeSection).success).toBe(true);
    expect(evidenceSectionSchema.safeParse(notApplicableSection).success).toBe(
      true,
    );

    for (const invalid of [
      { status: "complete", facts: [], warnings: [], errors: [] },
      {
        status: "complete",
        facts: [validSourceFact],
        warnings: [],
        errors: ["Do not call this complete."],
      },
      {
        status: "not_applicable",
        facts: [validSourceFact],
        warnings: ["No data applies."],
        errors: [],
      },
      { status: "not_applicable", facts: [], warnings: [], errors: [] },
      {
        status: "partial",
        facts: [validSourceFact],
        warnings: [],
        errors: [],
      },
      {
        status: "unavailable",
        facts: [validSourceFact],
        warnings: ["Endpoint unavailable."],
        errors: [],
      },
      { status: "unavailable", facts: [], warnings: [], errors: [] },
    ]) {
      expect(evidenceSectionSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("safe dossier errors", () => {
  it("redacts authorization, API-key, and token-shaped secrets from text", () => {
    const bearerValue = ["bearer", "credential", "example"].join("-");
    const basicValue = ["basic", "credential", "example"].join("-");
    const apiKeyValue = ["api", "key", "example"].join("-");
    const tokenValue = ["token", "example"].join("-");
    const authorizationHeader = ["Authorization", "Bearer"].join(": ");
    const basicAssignment = ["authorization", "Basic"].join("=");
    const apiKeyQuery = ["?api", "key"].join("_");
    const tokenAssignment = ["token", ""].join(": ");

    const redacted = redactSecretText(
      [
        `${authorizationHeader} ${bearerValue}`,
        `${basicAssignment} ${basicValue}`,
        `${apiKeyQuery}=${apiKeyValue}&company=00000006`,
        `${tokenAssignment}${tokenValue}`,
      ].join(" "),
    );

    expect(redacted).not.toContain(bearerValue);
    expect(redacted).not.toContain(basicValue);
    expect(redacted).not.toContain(apiKeyValue);
    expect(redacted).not.toContain(tokenValue);
    expect(redacted).toContain("[REDACTED]");
  });

  it("serializes typed errors without raw cause, headers, body, or credentials", () => {
    const credentialValue = ["credential", "example", "value"].join("-");
    const authorizationHeader = ["Authorization", "Bearer"].join(": ");
    const apiKeyAssignment = ["api", "key"].join("_");
    const tokenAssignment = ["token", ""].join("=");
    const message = `Companies House request failed: ${authorizationHeader} ${credentialValue}`;
    const cause = {
      code: "ECONNRESET",
      headers: {
        authorization: `Basic ${credentialValue}`,
      },
      body: `${apiKeyAssignment}=${credentialValue}`,
      message: `upstream ${tokenAssignment}${credentialValue}`,
      status: 503,
    };
    const errors = [
      new ConfigurationError(message, { cause }),
      new CompaniesHouseHttpError(message, {
        cause,
        retryAfterSeconds: 30,
        status: 503,
      }),
      new ResourceNotFoundError(message, { cause, status: 404 }),
      new RateLimitError(message, {
        cause,
        retryAfterSeconds: 60,
        status: 429,
      }),
      new DocumentSafetyError(message, { cause }),
      new SnapshotError(message, { cause }),
    ];

    expect(errors.map((error) => error.code)).toEqual([
      "configuration_error",
      "companies_house_http_error",
      "resource_not_found_error",
      "rate_limit_error",
      "document_safety_error",
      "snapshot_error",
    ]);

    for (const error of errors) {
      const exposedError = error as Error & {
        body?: unknown;
        cause?: unknown;
        headers?: unknown;
      };
      const serialized = JSON.stringify(error);

      expect(error.message).not.toContain(credentialValue);
      expect(serialized).not.toContain(credentialValue);
      expect(serialized).not.toContain("headers");
      expect(serialized).not.toContain("body");
      expect(exposedError.cause).toBeUndefined();
      expect(exposedError.headers).toBeUndefined();
      expect(exposedError.body).toBeUndefined();
    }

    expect(JSON.parse(JSON.stringify(errors[1]))).toMatchObject({
      code: "companies_house_http_error",
      message: expect.stringContaining("[REDACTED]") as string,
      retryAfterSeconds: 30,
      status: 503,
    });
  });
});
