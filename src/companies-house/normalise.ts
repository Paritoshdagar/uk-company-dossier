import { createHash } from "node:crypto";

import {
  evidenceRefSchema,
  type EvidenceRef,
} from "../contracts/company-evidence.js";
import { CompaniesHouseHttpError } from "../contracts/errors.js";

export interface CreateEvidenceRefInput {
  readonly documentId?: string;
  readonly rawBytes: Uint8Array;
  readonly retrievedAt: string;
  readonly sourceUri: string;
}

export interface CompaniesHouseAddress {
  readonly addressLine1?: string;
  readonly addressLine2?: string;
  readonly careOf?: string;
  readonly country?: string;
  readonly locality?: string;
  readonly poBox?: string;
  readonly postalCode?: string;
  readonly premises?: string;
  readonly region?: string;
}

export interface NormalisedCompanyProfile {
  readonly companyName: string;
  readonly companyNumber: string;
  readonly companyStatus?: string;
  readonly dateOfCreation?: string;
  readonly evidence: EvidenceRef;
  readonly jurisdiction?: string;
  readonly registeredOfficeAddress?: CompaniesHouseAddress;
  readonly sicCodes: readonly string[];
  readonly type?: string;
}

export interface NormalisedOfficer {
  readonly appointedOn?: string;
  readonly countryOfResidence?: string;
  readonly evidence: EvidenceRef;
  readonly id: string;
  readonly linksSelf?: string;
  readonly name?: string;
  readonly nationality?: string;
  readonly occupation?: string;
  readonly officerRole?: string;
  readonly resignedOn?: string;
}

export interface NormalisedPersonWithSignificantControl {
  readonly ceasedOn?: string;
  readonly evidence: EvidenceRef;
  readonly id: string;
  readonly kind?: string;
  readonly name?: string;
  readonly naturesOfControl: readonly string[];
  readonly notifiedOn?: string;
}

export interface NormalisedCharge {
  readonly classificationType?: string;
  readonly createdOn?: string;
  readonly deliveredOn?: string;
  readonly evidence: EvidenceRef;
  readonly id: string;
  readonly personsEntitled: readonly string[];
  readonly satisfiedOn?: string;
  readonly status?: string;
}

export interface NormalisedFilingHistoryItem {
  readonly category?: string;
  readonly date?: string;
  readonly description?: string;
  readonly documentMetadataPath?: string;
  readonly evidence: EvidenceRef;
  readonly id: string;
  readonly paperFiled?: boolean;
  readonly type?: string;
}

export interface NormalisedInsolvencyDate {
  readonly date?: string;
  readonly type?: string;
}

export interface NormalisedInsolvencyCase {
  readonly dates: readonly NormalisedInsolvencyDate[];
  readonly number?: string;
  readonly type?: string;
}

export interface NormalisedInsolvency {
  readonly cases: readonly NormalisedInsolvencyCase[];
  readonly evidence: EvidenceRef;
}

export interface FilingDocumentMetadataPathInput {
  readonly documentId?: string;
  readonly documentMetadataLink?: string;
}

const companyNumberPattern = /^[A-Z0-9]{8}$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

export function createEvidenceRef(input: CreateEvidenceRefInput): EvidenceRef {
  const candidate: {
    documentId?: string;
    payloadSha256: string;
    retrievedAt: string;
    sourceUri: string;
  } = {
    payloadSha256: createHash("sha256").update(input.rawBytes).digest("hex"),
    retrievedAt: input.retrievedAt,
    sourceUri: input.sourceUri,
  };

  if (input.documentId !== undefined) {
    candidate.documentId = input.documentId;
  }

  return evidenceRefSchema.parse(candidate);
}

export function normaliseCompanyNumber(companyNumber: string): string {
  const normalised = companyNumber.trim().toUpperCase();

  if (!companyNumberPattern.test(normalised)) {
    throw new CompaniesHouseHttpError(
      "Invalid Companies House company number. Expected 8 alphanumeric characters.",
    );
  }

  return normalised;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CompaniesHouseHttpError(
      `Companies House ${context} response was not a JSON object.`,
    );
  }

  return value;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredStringField(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = stringField(record, key);

  if (value === undefined) {
    throw new CompaniesHouseHttpError(
      `Companies House ${context} response was missing ${key}.`,
    );
  }

  return value;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];

  return typeof value === "boolean" ? value : undefined;
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];

  return isRecord(value) ? value : undefined;
}

function recordsArrayField(
  record: Record<string, unknown>,
  key: string,
): readonly Record<string, unknown>[] {
  const value = record[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function stringsArrayField(
  record: Record<string, unknown>,
  key: string,
): readonly string[] {
  const value = record[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function nestedStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  let current: unknown = record;

  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return typeof current === "string" && current.length > 0
    ? current
    : undefined;
}

function normaliseIsoDate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isoDatePattern.test(value)) {
    return value;
  }

  const parsedDateMs = Date.parse(value);

  if (!Number.isFinite(parsedDateMs)) {
    return undefined;
  }

  return new Date(parsedDateMs).toISOString().slice(0, 10);
}

function sortStrings(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sortById<TItem extends { readonly id: string }>(
  items: readonly TItem[],
): readonly TItem[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

type PossiblyUndefinedProperties<TValue extends object> = {
  [TKey in keyof TValue]-?: TValue[TKey] | undefined;
};

function withoutUndefined<TValue extends object>(
  value: PossiblyUndefinedProperties<TValue>,
): TValue {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as TValue;
}

function normaliseAddress(
  value: Record<string, unknown> | undefined,
): CompaniesHouseAddress | undefined {
  if (value === undefined) {
    return undefined;
  }

  const address = withoutUndefined<CompaniesHouseAddress>({
    addressLine1: stringField(value, "address_line_1"),
    addressLine2: stringField(value, "address_line_2"),
    careOf: stringField(value, "care_of"),
    country: stringField(value, "country"),
    locality: stringField(value, "locality"),
    poBox: stringField(value, "po_box"),
    postalCode: stringField(value, "postal_code"),
    premises: stringField(value, "premises"),
    region: stringField(value, "region"),
  });

  return Object.keys(address).length === 0 ? undefined : address;
}

function pageItems(
  value: unknown,
  context: string,
): readonly Record<string, unknown>[] {
  const record = requiredRecord(value, context);

  return recordsArrayField(record, "items");
}

function documentIdFromMetadataLink(link: string): string | undefined {
  try {
    const url = new URL(
      link,
      "https://document-api.company-information.service.gov.uk",
    );
    const [resourceName, documentId] = url.pathname
      .split("/")
      .filter((part) => part.length > 0);

    if (resourceName !== "document" || documentId === undefined) {
      return undefined;
    }

    return decodeURIComponent(documentId);
  } catch {
    return undefined;
  }
}

export function buildFilingDocumentMetadataPath(
  input: FilingDocumentMetadataPathInput,
): string {
  const documentId =
    input.documentId ??
    (input.documentMetadataLink === undefined
      ? undefined
      : documentIdFromMetadataLink(input.documentMetadataLink));

  if (documentId === undefined || documentId.trim().length === 0) {
    throw new CompaniesHouseHttpError(
      "Filing document metadata link did not contain a document identifier.",
    );
  }

  return `/document/${encodeURIComponent(documentId)}`;
}

export function normaliseCompanyProfile(
  value: unknown,
  evidence: EvidenceRef,
): NormalisedCompanyProfile {
  const record = requiredRecord(value, "company profile");
  const profile = withoutUndefined<NormalisedCompanyProfile>({
    companyName: requiredStringField(record, "company_name", "company profile"),
    companyNumber: normaliseCompanyNumber(
      requiredStringField(record, "company_number", "company profile"),
    ),
    companyStatus: stringField(record, "company_status"),
    dateOfCreation: normaliseIsoDate(stringField(record, "date_of_creation")),
    evidence,
    jurisdiction: stringField(record, "jurisdiction"),
    registeredOfficeAddress: normaliseAddress(
      recordField(record, "registered_office_address"),
    ),
    sicCodes: sortStrings(stringsArrayField(record, "sic_codes")),
    type: stringField(record, "type"),
  });

  return profile;
}

export function normaliseOfficers(
  value: unknown,
  evidence: EvidenceRef,
): readonly NormalisedOfficer[] {
  return sortById(
    pageItems(value, "officers").map((item) => {
      const linksSelf = nestedStringField(item, ["links", "self"]);
      const id = stringField(item, "appointment_id") ?? linksSelf;

      if (id === undefined) {
        throw new CompaniesHouseHttpError(
          "Companies House officer item was missing a stable identifier.",
        );
      }

      return withoutUndefined<NormalisedOfficer>({
        appointedOn: normaliseIsoDate(stringField(item, "appointed_on")),
        countryOfResidence: stringField(item, "country_of_residence"),
        evidence,
        id,
        linksSelf,
        name: stringField(item, "name"),
        nationality: stringField(item, "nationality"),
        occupation: stringField(item, "occupation"),
        officerRole: stringField(item, "officer_role"),
        resignedOn: normaliseIsoDate(stringField(item, "resigned_on")),
      });
    }),
  );
}

export function normalisePersonsWithSignificantControl(
  value: unknown,
  evidence: EvidenceRef,
): readonly NormalisedPersonWithSignificantControl[] {
  return sortById(
    pageItems(value, "persons with significant control").map((item) => {
      const id = nestedStringField(item, ["links", "self"]);

      if (id === undefined) {
        throw new CompaniesHouseHttpError(
          "Companies House PSC item was missing links.self.",
        );
      }

      return withoutUndefined<NormalisedPersonWithSignificantControl>({
        ceasedOn: normaliseIsoDate(stringField(item, "ceased_on")),
        evidence,
        id,
        kind: stringField(item, "kind"),
        name: stringField(item, "name"),
        naturesOfControl: sortStrings(
          stringsArrayField(item, "natures_of_control"),
        ),
        notifiedOn: normaliseIsoDate(stringField(item, "notified_on")),
      });
    }),
  );
}

export function normaliseCharges(
  value: unknown,
  evidence: EvidenceRef,
): readonly NormalisedCharge[] {
  return sortById(
    pageItems(value, "charges").map((item) => {
      const id =
        stringField(item, "charge_code") ??
        stringField(item, "id") ??
        nestedStringField(item, ["links", "self"]);

      if (id === undefined) {
        throw new CompaniesHouseHttpError(
          "Companies House charge item was missing a stable identifier.",
        );
      }

      return withoutUndefined<NormalisedCharge>({
        classificationType: nestedStringField(item, ["classification", "type"]),
        createdOn: normaliseIsoDate(stringField(item, "created_on")),
        deliveredOn: normaliseIsoDate(stringField(item, "delivered_on")),
        evidence,
        id,
        personsEntitled: sortStrings(
          recordsArrayField(item, "persons_entitled").flatMap((person) => {
            const name = stringField(person, "name");

            return name === undefined ? [] : [name];
          }),
        ),
        satisfiedOn: normaliseIsoDate(stringField(item, "satisfied_on")),
        status: stringField(item, "status"),
      });
    }),
  );
}

export function normaliseFilingHistory(
  value: unknown,
  evidence: EvidenceRef,
): readonly NormalisedFilingHistoryItem[] {
  return sortById(
    pageItems(value, "filing history").map((item) => {
      const id =
        stringField(item, "transaction_id") ??
        nestedStringField(item, ["links", "self"]);

      if (id === undefined) {
        throw new CompaniesHouseHttpError(
          "Companies House filing history item was missing a stable identifier.",
        );
      }

      const documentMetadataLink = nestedStringField(item, [
        "links",
        "document_metadata",
      ]);
      const documentMetadataPath =
        documentMetadataLink === undefined
          ? undefined
          : buildFilingDocumentMetadataPath({ documentMetadataLink });

      return withoutUndefined<NormalisedFilingHistoryItem>({
        category: stringField(item, "category"),
        date: normaliseIsoDate(stringField(item, "date")),
        description: stringField(item, "description"),
        documentMetadataPath,
        evidence,
        id,
        paperFiled: booleanField(item, "paper_filed"),
        type: stringField(item, "type"),
      });
    }),
  );
}

export function normaliseInsolvency(
  value: unknown,
  evidence: EvidenceRef,
): NormalisedInsolvency {
  const record = requiredRecord(value, "insolvency");
  const cases = recordsArrayField(record, "cases").map((insolvencyCase) =>
    withoutUndefined<NormalisedInsolvencyCase>({
      dates: recordsArrayField(insolvencyCase, "dates").map((dateRecord) =>
        withoutUndefined<NormalisedInsolvencyDate>({
          date: normaliseIsoDate(stringField(dateRecord, "date")),
          type: stringField(dateRecord, "type"),
        }),
      ),
      number: stringField(insolvencyCase, "number"),
      type: stringField(insolvencyCase, "type"),
    }),
  );

  return {
    cases: [...cases].sort((left, right) =>
      (left.number ?? "").localeCompare(right.number ?? ""),
    ),
    evidence,
  };
}
