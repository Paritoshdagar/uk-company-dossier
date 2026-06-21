import { z } from "zod";

export const COMPANY_EVIDENCE_SCHEMA_VERSION = "1.0.0" as const;

const stableIdentifierPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const normalizedTypePattern = /^[a-z][a-z0-9._:-]*$/;
const sectionKeyPattern = /^[a-z][a-z0-9_:-]*$/;
const companyNumberPattern = /^[0-9A-Z]{8}$/;
const lowercaseSha256Pattern = /^[0-9a-f]{64}$/;
const strictUriCharacterPattern = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*$/u;
const invalidPercentEncodingPattern = /%(?![0-9A-Fa-f]{2})/u;
const officialCompaniesHouseUriPattern =
  /^https:\/\/(?:(?:api|developer|find-and-update)\.company-information\.service\.gov\.uk|www\.gov\.uk)(?:[/?#]|$)/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function isStrictHttpsUri(value: string): boolean {
  if (!value.startsWith("https://")) {
    return false;
  }

  if (!strictUriCharacterPattern.test(value)) {
    return false;
  }

  if (invalidPercentEncodingPattern.test(value)) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isOfficialCompaniesHouseUri(value: string): boolean {
  if (!isStrictHttpsUri(value)) {
    return false;
  }

  if (!officialCompaniesHouseUriPattern.test(value)) {
    return false;
  }

  return true;
}

const nonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Expected a nonblank string.",
  });

const stableIdentifierSchema = z.string().regex(stableIdentifierPattern, {
  message:
    "Expected a stable lowercase identifier using letters, digits, dot, underscore, colon, or hyphen.",
});

const normalizedFactTypeSchema = z.string().regex(normalizedTypePattern, {
  message:
    "Expected a normalized lowercase fact type using letters, digits, dot, underscore, colon, or hyphen.",
});

const httpsUriSchema = z.string().refine(isStrictHttpsUri, {
  message: "Expected an HTTPS URI.",
});

const officialCompaniesHouseUriSchema = httpsUriSchema.refine(
  isOfficialCompaniesHouseUri,
  {
    message: "Expected an official Companies House or GOV.UK HTTPS URI.",
  },
);

export const evidenceStatusSchema = z.enum([
  "complete",
  "partial",
  "unavailable",
  "not_applicable",
]);

export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const evidenceRefSchema = z
  .object({
    sourceUri: httpsUriSchema.describe(
      "HTTPS URI for the official source payload or document.",
    ),
    retrievedAt: z.iso
      .datetime({ offset: true })
      .describe(
        "RFC3339 timestamp recording when the evidence payload was retrieved.",
      ),
    payloadSha256: z
      .string()
      .regex(lowercaseSha256Pattern)
      .describe("Lowercase hexadecimal SHA-256 digest of the payload."),
    documentId: nonBlankStringSchema
      .describe("Optional stable upstream document identifier.")
      .optional(),
  })
  .strict();

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export function createFactSchema<TValueSchema extends z.ZodType<JsonValue>>(
  valueSchema: TValueSchema,
) {
  const factBaseSchema = z
    .object({
      id: stableIdentifierSchema,
      type: normalizedFactTypeSchema,
      value: valueSchema,
      evidence: z.array(evidenceRefSchema).min(1),
    })
    .strict();
  const sourceFactSchema = factBaseSchema
    .extend({
      origin: z.literal("source"),
    })
    .strict();
  const derivedFactSchema = factBaseSchema
    .extend({
      origin: z.literal("derived"),
      ruleId: stableIdentifierSchema,
    })
    .strict();

  return z.discriminatedUnion("origin", [sourceFactSchema, derivedFactSchema]);
}

export const factSchema = createFactSchema(jsonValueSchema);

export type Fact = z.infer<typeof factSchema>;

export const evidenceSectionSchema = z
  .object({
    status: evidenceStatusSchema.describe(
      "Honest completeness status for the section: complete, partial, unavailable, or not_applicable.",
    ),
    facts: z.array(factSchema),
    warnings: z.array(nonBlankStringSchema),
    errors: z.array(nonBlankStringSchema),
  })
  .strict()
  .superRefine((section, context) => {
    if (section.status === "complete") {
      if (section.facts.length === 0) {
        context.addIssue({
          code: "custom",
          message: "Complete sections require at least one fact.",
          path: ["facts"],
        });
      }

      if (section.errors.length !== 0) {
        context.addIssue({
          code: "custom",
          message: "Complete sections cannot contain errors.",
          path: ["errors"],
        });
      }
    }

    if (section.status === "not_applicable") {
      if (section.facts.length !== 0) {
        context.addIssue({
          code: "custom",
          message: "Not-applicable sections cannot contain facts.",
          path: ["facts"],
        });
      }

      if (section.errors.length !== 0) {
        context.addIssue({
          code: "custom",
          message: "Not-applicable sections cannot contain errors.",
          path: ["errors"],
        });
      }

      if (section.warnings.length === 0) {
        context.addIssue({
          code: "custom",
          message:
            "Not-applicable sections require at least one explanatory warning.",
          path: ["warnings"],
        });
      }
    }

    if (section.status === "partial" || section.status === "unavailable") {
      if (section.warnings.length === 0 && section.errors.length === 0) {
        context.addIssue({
          code: "custom",
          message:
            "Partial and unavailable sections require at least one warning or error.",
          path: ["warnings"],
        });
      }
    }

    if (section.status === "unavailable" && section.facts.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "Unavailable sections cannot contain facts.",
        path: ["facts"],
      });
    }
  });

export type EvidenceSection = z.infer<typeof evidenceSectionSchema>;

export const companyIdentitySchema = z
  .object({
    companyNumber: z.string().regex(companyNumberPattern),
    registeredName: nonBlankStringSchema.optional(),
  })
  .strict();

export type CompanyIdentity = z.infer<typeof companyIdentitySchema>;

export const sourceAttributionSchema = z
  .object({
    provider: z.literal("Companies House"),
    sourceUri: officialCompaniesHouseUriSchema.describe(
      "Official Companies House HTTPS source URI.",
    ),
    licenceUri: officialCompaniesHouseUriSchema.describe(
      "Official Companies House or GOV.UK HTTPS licence URI.",
    ),
    dataTermsUri: officialCompaniesHouseUriSchema.describe(
      "Official Companies House or GOV.UK HTTPS data terms URI.",
    ),
    retrievalCaveat: nonBlankStringSchema.describe(
      "Renderer-safe caveat explaining the retrieval time and possible later source changes.",
    ),
    nonAffiliationStatement: nonBlankStringSchema.describe(
      "Renderer-safe statement that the dossier is not affiliated with Companies House.",
    ),
  })
  .strict();

export type SourceAttribution = z.infer<typeof sourceAttributionSchema>;

export const companyDossierSchema = z
  .object({
    schemaVersion: z.literal(COMPANY_EVIDENCE_SCHEMA_VERSION),
    company: companyIdentitySchema,
    generatedAt: z.iso.datetime({ offset: true }),
    sections: z
      .record(z.string().regex(sectionKeyPattern), evidenceSectionSchema)
      .refine((sections) => Object.keys(sections).length > 0, {
        message: "Dossiers require at least one evidence section.",
      }),
    sourceAttribution: sourceAttributionSchema,
  })
  .strict();

export type CompanyDossier = z.infer<typeof companyDossierSchema>;
