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
  sourceAttributionSchema,
  type CompanyDossier,
  type EvidenceStatus,
  type JsonValue,
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nestedArray(depth: number): JsonValue {
  let value: JsonValue = "leaf";

  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }

  return value;
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

function setFirstEvidenceSourceUri(
  dossier: CompanyDossier,
  sourceUri: string,
): void {
  const section = dossier.sections.company_profile;

  if (section === undefined) {
    throw new Error("Expected company_profile section in fixture.");
  }

  const fact = section.facts[0];

  if (fact === undefined) {
    throw new Error("Expected first fact in company_profile fixture.");
  }

  const evidence = fact.evidence[0];

  if (evidence === undefined) {
    throw new Error("Expected first evidence ref in company_profile fixture.");
  }

  evidence.sourceUri = sourceUri;
}

describe("company evidence contract fixtures", () => {
  it("self-validates the public JSON Schema document", async () => {
    const ajv = createAjv();
    const jsonSchema = (await loadJsonFile(schemaPath)) as AnySchema;

    expect(
      (jsonSchema as { readonly $id?: unknown }).$id,
      "schema $id should be pinned to the v1.0.0 release path",
    ).toBe(
      "https://raw.githubusercontent.com/Paritoshdagar/uk-company-dossier/v1.0.0/schemas/company-evidence.schema.json",
    );
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
      {
        ...validEvidenceRef,
        sourceUri: "HTTPS://api.company-information.service.gov.uk/company/1",
      },
      {
        ...validEvidenceRef,
        sourceUri:
          "https://api.company-information.service.gov.uk/company/has space",
      },
      {
        ...validEvidenceRef,
        sourceUri:
          "https://api.company-information.service.gov.uk/company/currency/£",
      },
      {
        ...validEvidenceRef,
        sourceUri:
          "https://user:pass@api.company-information.service.gov.uk/company/1",
      },
      {
        ...validEvidenceRef,
        sourceUri:
          "https://api.company-information.service.gov.uk/company/1?access_token=value",
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
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    const validValues: unknown[] = [
      null,
      true,
      42,
      "text",
      ["nested", 1, false, null],
      { nested: { array: [1, "two", null] } },
      JSON.parse('{"parsed":["json",1,true,null]}') as unknown,
      nestedArray(8),
      nestedArray(65),
    ];

    for (const value of validValues) {
      expect(
        jsonValueSchema.safeParse(value).success,
        `expected JSON value ${JSON.stringify(value)} to pass`,
      ).toBe(true);
    }

    expect(() => jsonValueSchema.safeParse(cyclicObject)).not.toThrow();

    for (const invalid of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      undefined,
      () => "not json",
      Symbol("not json"),
      1n,
      new Date("2026-06-21T10:30:00Z"),
      new Map([["key", "value"]]),
      cyclicObject,
    ]) {
      expect(
        jsonValueSchema.safeParse(invalid).success,
        `expected non-JSON value ${Object.prototype.toString.call(invalid)} to fail`,
      ).toBe(false);
    }
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

  it("matches JSON Schema value parity for deeply nested serializable JSON", async () => {
    const validator = await loadDossierJsonValidator();
    const dossier = companyDossierSchema.parse(
      await loadJsonFile(
        join(validFixturesRoot, "complete-source-dossier.json"),
      ),
    );
    const section = dossier.sections.company_profile;

    if (section?.facts[0] === undefined) {
      throw new Error("Expected company_profile fact in fixture.");
    }

    section.facts[0].value = nestedArray(65);

    expect(companyDossierSchema.safeParse(dossier).success).toBe(true);
    expect(validator(dossier), JSON.stringify(validator.errors)).toBe(true);
  });

  it("matches JSON Schema URI parity for official host query and lowercase scheme rules", async () => {
    const validator = await loadDossierJsonValidator();
    const fixture = (await loadJsonFile(
      join(validFixturesRoot, "complete-source-dossier.json"),
    )) as CompanyDossier;
    const officialQueryAtHost = cloneJson(fixture);

    officialQueryAtHost.sourceAttribution.sourceUri =
      "https://api.company-information.service.gov.uk?company=00000006";
    officialQueryAtHost.sourceAttribution.licenceUri =
      "https://developer.company-information.service.gov.uk?terms=licence";
    officialQueryAtHost.sourceAttribution.dataTermsUri =
      "https://www.gov.uk?terms=companies-house";

    expect(
      sourceAttributionSchema.safeParse(officialQueryAtHost.sourceAttribution)
        .success,
    ).toBe(true);
    expect(companyDossierSchema.safeParse(officialQueryAtHost).success).toBe(
      true,
    );
    expect(
      validator(officialQueryAtHost),
      JSON.stringify(validator.errors),
    ).toBe(true);
  });

  it("matches JSON Schema URI parity for raw and percent-encoded URI characters", async () => {
    const validator = await loadDossierJsonValidator();
    const fixture = companyDossierSchema.parse(
      await loadJsonFile(
        join(validFixturesRoot, "complete-source-dossier.json"),
      ),
    );
    const rawUriCases = [
      {
        description: "evidence URI with raw space",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://api.company-information.service.gov.uk/company/has space",
          );
        },
      },
      {
        description: "evidence URI with unescaped Unicode path",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://api.company-information.service.gov.uk/company/currency/£",
          );
        },
      },
      {
        description: "official URI with raw space",
        mutate: (dossier: CompanyDossier) => {
          dossier.sourceAttribution.sourceUri =
            "https://api.company-information.service.gov.uk/has space";
        },
      },
      {
        description: "official URI with unescaped Unicode path",
        mutate: (dossier: CompanyDossier) => {
          dossier.sourceAttribution.sourceUri =
            "https://api.company-information.service.gov.uk/currency/£";
        },
      },
    ];

    for (const { description, mutate } of rawUriCases) {
      const dossier = cloneJson(fixture);

      mutate(dossier);

      expect(
        companyDossierSchema.safeParse(dossier).success,
        `${description} should fail Zod`,
      ).toBe(false);
      expect(validator(dossier), `${description} should fail Ajv`).toBe(false);
    }

    const encodedDossier = cloneJson(fixture);

    setFirstEvidenceSourceUri(
      encodedDossier,
      "https://vendor.example/company/has%20space?document=has%20space&currency=%C2%A3#evidence",
    );
    encodedDossier.sourceAttribution.sourceUri =
      "https://api.company-information.service.gov.uk?company=00000006&currency=%C2%A3#source";

    expect(companyDossierSchema.safeParse(encodedDossier).success).toBe(true);
    expect(validator(encodedDossier), JSON.stringify(validator.errors)).toBe(
      true,
    );
  });

  it("matches JSON Schema URI parity by rejecting userinfo and credential query parameters", async () => {
    const validator = await loadDossierJsonValidator();
    const fixture = companyDossierSchema.parse(
      await loadJsonFile(
        join(validFixturesRoot, "complete-source-dossier.json"),
      ),
    );
    const credentialUriCases = [
      {
        description: "evidence URI with userinfo",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://user:pass@vendor.example/source.json",
          );
        },
      },
      {
        description: "evidence URI with token query parameter",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://vendor.example/source.json?token=value",
          );
        },
      },
      {
        description: "evidence URI with bare token query key",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://vendor.example/source.json?token",
          );
        },
      },
      {
        description: "evidence URI with bare token query key before safe key",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://vendor.example/source.json?token&company=00000006",
          );
        },
      },
      {
        description: "evidence URI with encoded access token query key",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://vendor.example/source.json?access%5Ftoken=value",
          );
        },
      },
      {
        description: "evidence URI with benign encoded query key",
        mutate: (dossier: CompanyDossier) => {
          setFirstEvidenceSourceUri(
            dossier,
            "https://vendor.example/source.json?safe%5Fkey=value",
          );
        },
      },
      {
        description: "official URI with access token query parameter",
        mutate: (dossier: CompanyDossier) => {
          dossier.sourceAttribution.sourceUri =
            "https://api.company-information.service.gov.uk/?access_token=value";
        },
      },
      {
        description: "official URI with bare API key query key",
        mutate: (dossier: CompanyDossier) => {
          dossier.sourceAttribution.sourceUri =
            "https://api.company-information.service.gov.uk/?api_key";
        },
      },
      {
        description: "official URI with client secret query parameter",
        mutate: (dossier: CompanyDossier) => {
          dossier.sourceAttribution.licenceUri =
            "https://developer.company-information.service.gov.uk/developer-guidelines?client_secret=value";
        },
      },
      {
        description: "official URI with encoded client secret query key",
        mutate: (dossier: CompanyDossier) => {
          dossier.sourceAttribution.licenceUri =
            "https://developer.company-information.service.gov.uk/developer-guidelines?client%5Fsecret=value";
        },
      },
    ];

    for (const { description, mutate } of credentialUriCases) {
      const dossier = cloneJson(fixture);

      mutate(dossier);

      expect(
        companyDossierSchema.safeParse(dossier).success,
        `${description} should fail Zod`,
      ).toBe(false);
      expect(validator(dossier), `${description} should fail Ajv`).toBe(false);
    }
  });
});

describe("safe dossier errors", () => {
  it("redacts authorization, API-key, and token-shaped secrets from text", () => {
    const bearerValue = ["bearer", "credential", "example"].join("-");
    const basicValue = ["basic", "credential", "example"].join("-");
    const apiKeyAuthorizationValue = ["api", "key", "credential"].join("-");
    const tokenAuthorizationValue = ["token", "credential"].join("-");
    const apiKeyValue = ["api", "key", "example"].join("-");
    const tokenValue = ["token", "example"].join("-");
    const authorizationHeader = ["Authorization", "Bearer"].join(": ");
    const basicAssignment = ["authorization", "Basic"].join("=");
    const apiKeyAuthorizationHeader = ["Authorization", "ApiKey"].join(": ");
    const tokenAuthorizationHeader = ["Authorization", "Token"].join(": ");
    const apiKeyQuery = ["?api", "key"].join("_");
    const tokenAssignment = ["token", ""].join(": ");

    const redacted = redactSecretText(
      [
        `${authorizationHeader} ${bearerValue}`,
        `${basicAssignment} ${basicValue}`,
        `${apiKeyAuthorizationHeader} ${apiKeyAuthorizationValue}`,
        `${tokenAuthorizationHeader} ${tokenAuthorizationValue}`,
        JSON.stringify({
          Authorization: `ApiKey ${apiKeyAuthorizationValue}`,
          authorization: `Token ${tokenAuthorizationValue}`,
        }),
        `${apiKeyQuery}=${apiKeyValue}&company=00000006`,
        `${tokenAssignment}${tokenValue}`,
      ].join(" "),
    );

    expect(redacted).not.toContain(bearerValue);
    expect(redacted).not.toContain(basicValue);
    expect(redacted).not.toContain(apiKeyAuthorizationValue);
    expect(redacted).not.toContain(tokenAuthorizationValue);
    expect(redacted).not.toContain(`ApiKey ${apiKeyAuthorizationValue}`);
    expect(redacted).not.toContain(`Token ${tokenAuthorizationValue}`);
    expect(redacted).not.toContain(apiKeyValue);
    expect(redacted).not.toContain(tokenValue);
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts full authorization values for parameterized and multi-part schemes", () => {
    const cases = [
      {
        input:
          "Authorization: AWS4-HMAC-SHA256 Credential=abc, SignedHeaders=host, Signature=secret-signature",
        leaks: [
          "AWS4-HMAC-SHA256",
          "Credential=abc",
          "SignedHeaders=host",
          "secret-signature",
        ],
      },
      {
        input:
          'Authorization: Digest username="user", realm="realm", nonce="nonce", response="secret-response"',
        leaks: [
          "Digest",
          'username="user"',
          'realm="realm"',
          'nonce="nonce"',
          "secret-response",
        ],
      },
      {
        input: "Authorization: CustomScheme part-one part-two part-three",
        leaks: ["CustomScheme", "part-one", "part-two", "part-three"],
      },
    ];

    for (const { input, leaks } of cases) {
      const redacted = redactSecretText(input);

      expect(redacted).toBe("Authorization: [REDACTED]");

      for (const leak of leaks) {
        expect(redacted).not.toContain(leak);
      }
    }
  });

  it("keeps JSON-shaped authorization redaction valid and quoted", () => {
    const jsonSecret = "json-secret";
    const redacted = redactSecretText(
      JSON.stringify({ authorization: `ApiKey ${jsonSecret}` }),
    );

    expect(redacted).not.toContain(jsonSecret);
    expect(JSON.parse(redacted)).toEqual({ authorization: "[REDACTED]" });
  });

  it("keeps JSON-shaped authorization redaction valid when values contain escaped quotes", () => {
    const redacted = redactSecretText(
      JSON.stringify({
        authorization:
          'Digest username="user", nonce="nonce-value", response="secret-response"',
        other: "ok",
      }),
    );

    expect(redacted).not.toContain("nonce-value");
    expect(redacted).not.toContain("secret-response");
    expect(redacted).not.toContain("username");
    expect(JSON.parse(redacted)).toEqual({
      authorization: "[REDACTED]",
      other: "ok",
    });
  });

  it("redacts common token field variants from assignments and JSON-shaped text", () => {
    const fields = [
      ["access", "token"].join("_"),
      ["refresh", "token"].join("_"),
      ["id", "token"].join("_"),
      ["access", "Token"].join(""),
      ["refresh", "Token"].join(""),
      ["api", "Token"].join(""),
    ];
    const cases = fields.map((field, index) => ({
      field,
      value: [field.toLowerCase(), "value", String(index)].join("-"),
    }));
    const text = cases
      .flatMap(({ field, value }) => [
        `${field}=${value}`,
        JSON.stringify({ [field]: value }),
      ])
      .join(" ");
    const redacted = redactSecretText(text);

    for (const { value } of cases) {
      expect(redacted).not.toContain(value);
    }

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
