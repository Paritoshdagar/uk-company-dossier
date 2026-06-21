import type { PaginatedCompaniesHouseResource } from "../companies-house/endpoints.js";
import {
  normaliseCompanyNumber,
  type NormalisedCharge,
  type NormalisedCompanyProfile,
  type NormalisedFilingHistoryItem,
  type NormalisedInsolvency,
  type NormalisedInsolvencyCase,
  type NormalisedOfficer,
  type NormalisedPersonWithSignificantControl,
} from "../companies-house/normalise.js";
import {
  COMPANY_EVIDENCE_SCHEMA_VERSION,
  companyDossierSchema,
  type CompanyDossier,
  type EvidenceRef,
  type EvidenceSection,
  type Fact,
  type JsonValue,
} from "../contracts/company-evidence.js";
import { DossierError, redactSecretText } from "../contracts/errors.js";

export interface DossierClock {
  now: () => Date | string;
}

export interface AvailableEndpointResult<TResource> {
  readonly kind: "available";
  readonly resource: TResource;
}

export interface PartialEndpointResult<TResource> {
  readonly kind: "partial";
  readonly resource: TResource;
  readonly warnings: readonly string[];
}

export interface NotApplicableEndpointResult {
  readonly evidence: readonly EvidenceRef[];
  readonly kind: "not_applicable";
  readonly reason: string;
  readonly ruleId: string;
}

export type DossierEndpointOutcome<TResource> =
  | AvailableEndpointResult<TResource>
  | NotApplicableEndpointResult
  | PartialEndpointResult<TResource>;

export type DossierEndpointResult<TResource> =
  | DossierEndpointOutcome<TResource>
  | TResource;

export interface DossierEndpointGateway {
  fetchCompanyCharges: (
    companyNumber: string,
  ) => Promise<
    DossierEndpointResult<PaginatedCompaniesHouseResource<NormalisedCharge>>
  >;
  fetchCompanyFilingHistory: (
    companyNumber: string,
  ) => Promise<
    DossierEndpointResult<
      PaginatedCompaniesHouseResource<NormalisedFilingHistoryItem>
    >
  >;
  fetchCompanyInsolvency: (
    companyNumber: string,
  ) => Promise<DossierEndpointResult<NormalisedInsolvency>>;
  fetchCompanyOfficers: (
    companyNumber: string,
  ) => Promise<
    DossierEndpointResult<PaginatedCompaniesHouseResource<NormalisedOfficer>>
  >;
  fetchCompanyProfile: (
    companyNumber: string,
  ) => Promise<DossierEndpointResult<NormalisedCompanyProfile>>;
  fetchPersonsWithSignificantControl: (
    companyNumber: string,
  ) => Promise<
    DossierEndpointResult<
      PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl>
    >
  >;
}

export interface BuildCompanyDossierInput {
  readonly clock: DossierClock;
  readonly companyNumber: string;
  readonly gateway: DossierEndpointGateway;
}

interface SectionBuilder {
  readonly build: () => Promise<EvidenceSection>;
  readonly key: SectionKey;
  readonly ruleId: string;
}

interface ResourceSectionInput<TResource> {
  readonly buildFacts: (
    resource: TResource,
    completeness: "complete" | "partial",
  ) => readonly Fact[];
  readonly resourceWarnings?: (resource: TResource) => readonly string[];
  readonly ruleId: string;
  readonly sectionLabel: string;
  readonly request: () => Promise<DossierEndpointResult<TResource>>;
}

type SectionKey =
  | "charges"
  | "filings"
  | "insolvency"
  | "officers"
  | "profile"
  | "pscs";

const profileRuleId = "dossier.section.profile.v1";
const officersRuleId = "dossier.section.officers.v1";
const pscsRuleId = "dossier.section.pscs.v1";
const chargesRuleId = "dossier.section.charges.v1";
const insolvencyRuleId = "dossier.section.insolvency.v1";
const filingsRuleId = "dossier.section.filings.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEndpointOutcome<TResource>(
  value: DossierEndpointResult<TResource>,
): value is DossierEndpointOutcome<TResource> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.kind === "available" ||
    value.kind === "partial" ||
    value.kind === "not_applicable"
  );
}

function asEndpointOutcome<TResource>(
  value: DossierEndpointResult<TResource>,
): DossierEndpointOutcome<TResource> {
  if (isEndpointOutcome(value)) {
    return value;
  }

  return {
    kind: "available",
    resource: value,
  };
}

function generatedAt(clock: DossierClock): string {
  const value = clock.now();

  return value instanceof Date ? value.toISOString() : value;
}

function sourceAttribution(
  retrievedAt: string,
): CompanyDossier["sourceAttribution"] {
  return {
    dataTermsUri: "https://developer.company-information.service.gov.uk",
    licenceUri:
      "https://www.gov.uk/government/organisations/companies-house/about/personal-information-charter",
    nonAffiliationStatement:
      "This dossier is not affiliated with or endorsed by Companies House.",
    provider: "Companies House",
    retrievalCaveat: `Companies House data was retrieved at ${retrievedAt}; upstream records may change after that time.`,
    sourceUri: "https://api.company-information.service.gov.uk",
  };
}

function compactObject(
  entries: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
  const value: Record<string, JsonValue> = {};

  for (const [key, entryValue] of Object.entries(entries)) {
    if (entryValue !== undefined) {
      value[key] = entryValue;
    }
  }

  return value;
}

function sourceFact(input: {
  readonly evidence: readonly EvidenceRef[];
  readonly id: string;
  readonly type: string;
  readonly value: JsonValue;
}): Fact {
  return {
    evidence: [...input.evidence],
    id: input.id,
    origin: "source",
    type: input.type,
    value: input.value,
  };
}

function derivedFact(input: {
  readonly evidence: readonly EvidenceRef[];
  readonly id: string;
  readonly ruleId: string;
  readonly type: string;
  readonly value: JsonValue;
}): Fact {
  return {
    evidence: [...input.evidence],
    id: input.id,
    origin: "derived",
    ruleId: input.ruleId,
    type: input.type,
    value: input.value,
  };
}

function stableSuffix(rawValue: string, fallbackIndex: number): string {
  const candidate = rawValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .replace(/[^a-z0-9]+$/u, "");

  return candidate.length > 0 ? candidate : `item-${String(fallbackIndex + 1)}`;
}

function sourceFactId(
  sectionPrefix: string,
  upstreamId: string,
  index: number,
): string {
  return `${sectionPrefix}.${stableSuffix(upstreamId, index)}`;
}

function evidenceListSummary(evidence: readonly EvidenceRef[]): string {
  if (evidence.length === 0) {
    return "no upstream evidence reference was supplied";
  }

  return evidence
    .map(
      (reference) => `${reference.sourceUri}#sha256=${reference.payloadSha256}`,
    )
    .join(", ");
}

function notApplicableSection(
  sectionLabel: string,
  outcome: NotApplicableEndpointResult,
): EvidenceSection {
  return {
    errors: [],
    facts: [],
    status: "not_applicable",
    warnings: [
      `Rule ${outcome.ruleId} marked ${sectionLabel} not applicable: ${outcome.reason}. Upstream evidence: ${evidenceListSummary(
        outcome.evidence,
      )}.`,
    ],
  };
}

function sectionWithFacts(input: {
  readonly facts: readonly Fact[];
  readonly ruleId: string;
  readonly sectionLabel: string;
  readonly status: "complete" | "partial";
  readonly warnings: readonly string[];
}): EvidenceSection {
  if (input.status === "complete" && input.facts.length === 0) {
    return {
      errors: [],
      facts: [],
      status: "unavailable",
      warnings: [
        `Rule ${input.ruleId} could not complete ${input.sectionLabel}: the endpoint returned no usable facts.`,
      ],
    };
  }

  return {
    errors: [],
    facts: [...input.facts],
    status: input.status,
    warnings: [...input.warnings],
  };
}

function serializeError(error: unknown): string {
  if (error instanceof DossierError) {
    return JSON.stringify(error.toJSON());
  }

  if (error instanceof Error) {
    return JSON.stringify({
      code: "unknown_error",
      message: redactSecretText(error.message),
      name: error.name,
    });
  }

  return JSON.stringify({
    code: "unknown_error",
    message: redactSecretText(String(error)),
    name: "NonErrorThrown",
  });
}

function unavailableSection(
  sectionLabel: string,
  ruleId: string,
  error: unknown,
): EvidenceSection {
  return {
    errors: [
      `Rule ${ruleId} could not retrieve ${sectionLabel}: ${serializeError(
        error,
      )}`,
    ],
    facts: [],
    status: "unavailable",
    warnings: [],
  };
}

async function buildResourceSection<TResource>(
  input: ResourceSectionInput<TResource>,
): Promise<EvidenceSection> {
  const outcome = asEndpointOutcome(await input.request());

  if (outcome.kind === "not_applicable") {
    return notApplicableSection(input.sectionLabel, outcome);
  }

  const completeness = outcome.kind === "partial" ? "partial" : "complete";
  const resourceWarnings = input.resourceWarnings?.(outcome.resource) ?? [];
  const endpointWarnings = outcome.kind === "partial" ? outcome.warnings : [];

  return sectionWithFacts({
    facts: input.buildFacts(outcome.resource, completeness),
    ruleId: input.ruleId,
    sectionLabel: input.sectionLabel,
    status: completeness,
    warnings: [...resourceWarnings, ...endpointWarnings],
  });
}

function profileFacts(profile: NormalisedCompanyProfile): readonly Fact[] {
  const evidence = [profile.evidence];
  const facts: Fact[] = [
    sourceFact({
      evidence,
      id: "profile.company_number",
      type: "company.number",
      value: profile.companyNumber,
    }),
    sourceFact({
      evidence,
      id: "profile.registered_name",
      type: "company.registered_name",
      value: profile.companyName,
    }),
  ];

  if (profile.companyStatus !== undefined) {
    facts.push(
      sourceFact({
        evidence,
        id: "profile.status",
        type: "company.status",
        value: profile.companyStatus,
      }),
    );
  }

  if (profile.dateOfCreation !== undefined) {
    facts.push(
      sourceFact({
        evidence,
        id: "profile.date_of_creation",
        type: "company.date_of_creation",
        value: profile.dateOfCreation,
      }),
    );
  }

  if (profile.jurisdiction !== undefined) {
    facts.push(
      sourceFact({
        evidence,
        id: "profile.jurisdiction",
        type: "company.jurisdiction",
        value: profile.jurisdiction,
      }),
    );
  }

  if (profile.type !== undefined) {
    facts.push(
      sourceFact({
        evidence,
        id: "profile.type",
        type: "company.type",
        value: profile.type,
      }),
    );
  }

  if (profile.sicCodes.length > 0) {
    facts.push(
      sourceFact({
        evidence,
        id: "profile.sic_codes",
        type: "company.sic_codes",
        value: [...profile.sicCodes],
      }),
    );
  }

  if (profile.registeredOfficeAddress !== undefined) {
    const address = profile.registeredOfficeAddress;

    facts.push(
      sourceFact({
        evidence,
        id: "profile.registered_office_address",
        type: "company.registered_office_address",
        value: compactObject({
          address_line_1: address.addressLine1,
          address_line_2: address.addressLine2,
          care_of: address.careOf,
          country: address.country,
          locality: address.locality,
          po_box: address.poBox,
          postal_code: address.postalCode,
          premises: address.premises,
          region: address.region,
        }),
      }),
    );
  }

  return facts;
}

function officersFacts(
  resource: PaginatedCompaniesHouseResource<NormalisedOfficer>,
  completeness: "complete" | "partial",
): readonly Fact[] {
  const facts = resource.items.map((officer, index) =>
    sourceFact({
      evidence: [officer.evidence],
      id: sourceFactId("officers", officer.id, index),
      type: "officers.appointment",
      value: compactObject({
        appointed_on: officer.appointedOn,
        country_of_residence: officer.countryOfResidence,
        id: officer.id,
        links_self: officer.linksSelf,
        name: officer.name,
        nationality: officer.nationality,
        occupation: officer.occupation,
        officer_role: officer.officerRole,
        resigned_on: officer.resignedOn,
      }),
    }),
  );

  if (completeness === "complete") {
    facts.push(
      derivedFact({
        evidence: resource.evidence,
        id: "officers.count",
        ruleId: officersRuleId,
        type: "officers.count",
        value: resource.items.length,
      }),
    );
  }

  return facts;
}

function pscFacts(
  resource: PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl>,
  completeness: "complete" | "partial",
): readonly Fact[] {
  const facts = resource.items.map((psc, index) =>
    sourceFact({
      evidence: [psc.evidence],
      id: sourceFactId("pscs", psc.id, index),
      type: "pscs.person_with_significant_control",
      value: compactObject({
        ceased_on: psc.ceasedOn,
        id: psc.id,
        kind: psc.kind,
        name: psc.name,
        natures_of_control: [...psc.naturesOfControl],
        notified_on: psc.notifiedOn,
      }),
    }),
  );

  if (completeness === "complete") {
    facts.push(
      derivedFact({
        evidence: resource.evidence,
        id: "pscs.count",
        ruleId: pscsRuleId,
        type: "pscs.count",
        value: resource.items.length,
      }),
    );
  }

  return facts;
}

function isActiveCharge(charge: NormalisedCharge): boolean {
  if (charge.satisfiedOn !== undefined) {
    return false;
  }

  const status = charge.status?.toLowerCase();

  return status?.includes("satisfied") !== true;
}

function chargeFacts(
  resource: PaginatedCompaniesHouseResource<NormalisedCharge>,
  completeness: "complete" | "partial",
): readonly Fact[] {
  const facts = resource.items.map((charge, index) =>
    sourceFact({
      evidence: [charge.evidence],
      id: sourceFactId("charges", charge.id, index),
      type: "charges.charge",
      value: compactObject({
        classification_type: charge.classificationType,
        created_on: charge.createdOn,
        delivered_on: charge.deliveredOn,
        id: charge.id,
        persons_entitled: [...charge.personsEntitled],
        satisfied_on: charge.satisfiedOn,
        status: charge.status,
      }),
    }),
  );

  if (completeness === "complete") {
    const activeCharges = resource.items.filter(isActiveCharge);

    facts.push(
      derivedFact({
        evidence: resource.evidence,
        id: "charges.count",
        ruleId: chargesRuleId,
        type: "charges.count",
        value: resource.items.length,
      }),
      derivedFact({
        evidence: resource.evidence,
        id: "charges.active_count",
        ruleId: chargesRuleId,
        type: "charges.active_count",
        value: activeCharges.length,
      }),
      derivedFact({
        evidence: resource.evidence,
        id: "charges.no_active",
        ruleId: chargesRuleId,
        type: "charges.no_active",
        value: activeCharges.length === 0,
      }),
    );
  }

  return facts;
}

function insolvencyCaseValue(
  insolvencyCase: NormalisedInsolvencyCase,
): JsonValue {
  return compactObject({
    dates: insolvencyCase.dates.map((dateRecord) =>
      compactObject({
        date: dateRecord.date,
        type: dateRecord.type,
      }),
    ),
    number: insolvencyCase.number,
    type: insolvencyCase.type,
  });
}

function insolvencyFacts(
  resource: NormalisedInsolvency,
  completeness: "complete" | "partial",
): readonly Fact[] {
  const facts = resource.cases.map((insolvencyCase, index) =>
    sourceFact({
      evidence: [resource.evidence],
      id: sourceFactId("insolvency", insolvencyCase.number ?? "case", index),
      type: "insolvency.case",
      value: insolvencyCaseValue(insolvencyCase),
    }),
  );

  if (completeness === "complete") {
    facts.push(
      derivedFact({
        evidence: [resource.evidence],
        id: "insolvency.case_count",
        ruleId: insolvencyRuleId,
        type: "insolvency.case_count",
        value: resource.cases.length,
      }),
    );
  }

  return facts;
}

function filingFacts(
  resource: PaginatedCompaniesHouseResource<NormalisedFilingHistoryItem>,
  completeness: "complete" | "partial",
): readonly Fact[] {
  const facts = resource.items.map((filing, index) =>
    sourceFact({
      evidence: [filing.evidence],
      id: sourceFactId("filings", filing.id, index),
      type: "filings.item",
      value: compactObject({
        category: filing.category,
        date: filing.date,
        description: filing.description,
        document_metadata_path: filing.documentMetadataPath,
        id: filing.id,
        paper_filed: filing.paperFiled,
        type: filing.type,
      }),
    }),
  );

  if (completeness === "complete") {
    facts.push(
      derivedFact({
        evidence: resource.evidence,
        id: "filings.count",
        ruleId: filingsRuleId,
        type: "filings.count",
        value: resource.items.length,
      }),
    );
  }

  return facts;
}

function paginatedWarnings<TItem>(
  resource: PaginatedCompaniesHouseResource<TItem>,
): readonly string[] {
  return resource.warnings;
}

function sectionBuilders(
  gateway: DossierEndpointGateway,
  companyNumber: string,
): readonly SectionBuilder[] {
  return [
    {
      build: () =>
        buildResourceSection({
          buildFacts: profileFacts,
          request: () => gateway.fetchCompanyProfile(companyNumber),
          ruleId: profileRuleId,
          sectionLabel: "profile",
        }),
      key: "profile",
      ruleId: profileRuleId,
    },
    {
      build: () =>
        buildResourceSection({
          buildFacts: officersFacts,
          request: () => gateway.fetchCompanyOfficers(companyNumber),
          resourceWarnings: paginatedWarnings,
          ruleId: officersRuleId,
          sectionLabel: "officers",
        }),
      key: "officers",
      ruleId: officersRuleId,
    },
    {
      build: () =>
        buildResourceSection({
          buildFacts: pscFacts,
          request: () =>
            gateway.fetchPersonsWithSignificantControl(companyNumber),
          resourceWarnings: paginatedWarnings,
          ruleId: pscsRuleId,
          sectionLabel: "persons with significant control",
        }),
      key: "pscs",
      ruleId: pscsRuleId,
    },
    {
      build: () =>
        buildResourceSection({
          buildFacts: chargeFacts,
          request: () => gateway.fetchCompanyCharges(companyNumber),
          resourceWarnings: paginatedWarnings,
          ruleId: chargesRuleId,
          sectionLabel: "charges",
        }),
      key: "charges",
      ruleId: chargesRuleId,
    },
    {
      build: () =>
        buildResourceSection({
          buildFacts: insolvencyFacts,
          request: () => gateway.fetchCompanyInsolvency(companyNumber),
          ruleId: insolvencyRuleId,
          sectionLabel: "insolvency",
        }),
      key: "insolvency",
      ruleId: insolvencyRuleId,
    },
    {
      build: () =>
        buildResourceSection({
          buildFacts: filingFacts,
          request: () => gateway.fetchCompanyFilingHistory(companyNumber),
          resourceWarnings: paginatedWarnings,
          ruleId: filingsRuleId,
          sectionLabel: "filing history",
        }),
      key: "filings",
      ruleId: filingsRuleId,
    },
  ];
}

function registeredNameFromProfile(
  section: EvidenceSection,
): string | undefined {
  const registeredNameFact = section.facts.find(
    (fact) => fact.id === "profile.registered_name",
  );

  return typeof registeredNameFact?.value === "string"
    ? registeredNameFact.value
    : undefined;
}

export async function buildCompanyDossier(
  input: BuildCompanyDossierInput,
): Promise<CompanyDossier> {
  const normalisedCompanyNumber = normaliseCompanyNumber(input.companyNumber);
  const generatedTimestamp = generatedAt(input.clock);
  const builders = sectionBuilders(input.gateway, normalisedCompanyNumber);
  const settledSections = await Promise.allSettled(
    builders.map((builder) => builder.build()),
  );
  const sections: Record<string, EvidenceSection> = {};

  for (const [index, settledSection] of settledSections.entries()) {
    const builder = builders[index];

    if (builder === undefined) {
      continue;
    }

    sections[builder.key] =
      settledSection.status === "fulfilled"
        ? settledSection.value
        : unavailableSection(
            builder.key,
            builder.ruleId,
            settledSection.reason,
          );
  }

  const registeredName = registeredNameFromProfile(
    sections.profile ?? {
      errors: [],
      facts: [],
      status: "unavailable",
      warnings: [],
    },
  );
  const company: CompanyDossier["company"] = {
    companyNumber: normalisedCompanyNumber,
  };

  if (registeredName !== undefined) {
    company.registeredName = registeredName;
  }

  return companyDossierSchema.parse({
    company,
    generatedAt: generatedTimestamp,
    schemaVersion: COMPANY_EVIDENCE_SCHEMA_VERSION,
    sections,
    sourceAttribution: sourceAttribution(generatedTimestamp),
  });
}
