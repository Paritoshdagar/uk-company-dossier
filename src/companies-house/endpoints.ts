import {
  type CompaniesHouseClient,
  type CompaniesHouseJsonResponse,
} from "./client.js";
import {
  createEvidenceRef,
  normaliseCharges,
  normaliseCompanyNumber,
  normaliseCompanyProfile,
  normaliseFilingHistory,
  normaliseInsolvency,
  normaliseOfficers,
  normalisePersonsWithSignificantControl,
  type NormalisedCharge,
  type NormalisedCompanyProfile,
  type NormalisedFilingHistoryItem,
  type NormalisedInsolvency,
  type NormalisedOfficer,
  type NormalisedPersonWithSignificantControl,
} from "./normalise.js";
import type { EvidenceRef } from "../contracts/company-evidence.js";
import { CompaniesHouseHttpError } from "../contracts/errors.js";

export { buildFilingDocumentMetadataPath } from "./normalise.js";

export interface PaginationOptions {
  readonly itemsPerPage?: number;
  readonly startIndex?: number;
}

export interface PaginatedCompaniesHouseResource<TItem> {
  readonly companyNumber: string;
  readonly evidence: readonly EvidenceRef[];
  readonly items: readonly TItem[];
  readonly warnings: readonly string[];
}

export interface CollectPaginatedResourceOptions<TItem> {
  readonly buildPath: (
    companyNumber: string,
    options: Required<PaginationOptions>,
  ) => string;
  readonly client: CompaniesHouseClient;
  readonly companyNumber: string;
  readonly getItemId: (item: TItem) => string;
  readonly itemsPerPage?: number;
  readonly normalisePage: (
    page: unknown,
    evidence: EvidenceRef,
  ) => readonly TItem[];
  readonly resourceName: string;
  readonly startIndex?: number;
}

const defaultItemsPerPage = 25;

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new CompaniesHouseHttpError(
      `${label} must be a positive integer for Companies House pagination.`,
    );
  }

  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CompaniesHouseHttpError(
      `${label} must be a non-negative integer for Companies House pagination.`,
    );
  }

  return value;
}

function resolvedPaginationOptions(
  options: PaginationOptions = {},
): Required<PaginationOptions> {
  return {
    itemsPerPage: positiveInteger(
      options.itemsPerPage ?? defaultItemsPerPage,
      "itemsPerPage",
    ),
    startIndex: nonNegativeInteger(options.startIndex ?? 0, "startIndex"),
  };
}

function paginationOptionsFromValues(
  itemsPerPage: number | undefined,
  startIndex: number | undefined,
): PaginationOptions {
  const options: {
    itemsPerPage?: number;
    startIndex?: number;
  } = {};

  if (itemsPerPage !== undefined) {
    options.itemsPerPage = itemsPerPage;
  }

  if (startIndex !== undefined) {
    options.startIndex = startIndex;
  }

  return options;
}

function buildPathWithOptionalPagination(
  companyNumber: string,
  resourcePath: string,
  options: PaginationOptions = {},
): string {
  const normalisedCompanyNumber = normaliseCompanyNumber(companyNumber);
  const pagination = resolvedPaginationOptions(options);
  const query = new URLSearchParams([
    ["items_per_page", String(pagination.itemsPerPage)],
    ["start_index", String(pagination.startIndex)],
  ]);

  return `/company/${normalisedCompanyNumber}/${resourcePath}?${query.toString()}`;
}

export function buildCompanyProfilePath(companyNumber: string): string {
  return `/company/${normaliseCompanyNumber(companyNumber)}`;
}

export function buildCompanyOfficersPath(
  companyNumber: string,
  options: PaginationOptions = {},
): string {
  return buildPathWithOptionalPagination(companyNumber, "officers", options);
}

export function buildPersonsWithSignificantControlPath(
  companyNumber: string,
  options: PaginationOptions = {},
): string {
  return buildPathWithOptionalPagination(
    companyNumber,
    "persons-with-significant-control",
    options,
  );
}

export function buildCompanyChargesPath(
  companyNumber: string,
  options: PaginationOptions = {},
): string {
  return buildPathWithOptionalPagination(companyNumber, "charges", options);
}

export function buildCompanyInsolvencyPath(companyNumber: string): string {
  return `/company/${normaliseCompanyNumber(companyNumber)}/insolvency`;
}

export function buildCompanyFilingHistoryPath(
  companyNumber: string,
  options: PaginationOptions = {},
): string {
  return buildPathWithOptionalPagination(
    companyNumber,
    "filing-history",
    options,
  );
}

function createEvidenceRefFromResponse(
  response: CompaniesHouseJsonResponse,
): EvidenceRef {
  return createEvidenceRef({
    rawBytes: response.rawBytes,
    retrievedAt: response.retrievedAt,
    sourceUri: response.finalUrl,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function returnedItemCount(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return 0;
  }

  return value.items.length;
}

function totalResults(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const total = value.total_results;

  return typeof total === "number" && Number.isFinite(total) && total >= 0
    ? total
    : undefined;
}

function sortByStableId<TItem>(
  items: readonly TItem[],
  getItemId: (item: TItem) => string,
): readonly TItem[] {
  return [...items].sort((left, right) =>
    getItemId(left).localeCompare(getItemId(right)),
  );
}

export async function collectPaginatedResource<TItem>(
  options: CollectPaginatedResourceOptions<TItem>,
): Promise<PaginatedCompaniesHouseResource<TItem>> {
  const companyNumber = normaliseCompanyNumber(options.companyNumber);
  const pagination = resolvedPaginationOptions(
    paginationOptionsFromValues(options.itemsPerPage, options.startIndex),
  );
  const collectedItems: TItem[] = [];
  const evidenceRefs: EvidenceRef[] = [];
  const seenItemIds = new Set<string>();
  const warnings: string[] = [];
  let currentStartIndex = pagination.startIndex;

  for (;;) {
    const path = options.buildPath(companyNumber, {
      itemsPerPage: pagination.itemsPerPage,
      startIndex: currentStartIndex,
    });
    const response = await options.client.requestJson(path);
    const evidence = createEvidenceRefFromResponse(response);
    const pageItems = options.normalisePage(response.data, evidence);
    const rawItemCount = returnedItemCount(response.data);
    const upstreamTotalResults = totalResults(response.data);

    evidenceRefs.push(evidence);

    for (const item of pageItems) {
      const itemId = options.getItemId(item);

      if (seenItemIds.has(itemId)) {
        warnings.push(
          `Duplicate ${options.resourceName} item with stable identifier ${itemId} omitted.`,
        );
        continue;
      }

      seenItemIds.add(itemId);
      collectedItems.push(item);
    }

    if (rawItemCount === 0) {
      if (
        upstreamTotalResults !== undefined &&
        currentStartIndex < upstreamTotalResults
      ) {
        warnings.push(
          `Stopped ${options.resourceName} pagination after empty page at start_index ${String(
            currentStartIndex,
          )} despite total_results ${String(upstreamTotalResults)}.`,
        );
      }

      break;
    }

    const nextStartIndex = currentStartIndex + rawItemCount;

    if (
      upstreamTotalResults !== undefined &&
      nextStartIndex >= upstreamTotalResults
    ) {
      break;
    }

    currentStartIndex = nextStartIndex;
  }

  return {
    companyNumber,
    evidence: evidenceRefs,
    items: sortByStableId(collectedItems, options.getItemId),
    warnings,
  };
}

export async function fetchCompanyProfile(
  client: CompaniesHouseClient,
  companyNumber: string,
): Promise<NormalisedCompanyProfile> {
  const response = await client.requestJson(
    buildCompanyProfilePath(companyNumber),
  );

  return normaliseCompanyProfile(
    response.data,
    createEvidenceRefFromResponse(response),
  );
}

export async function fetchCompanyOfficers(
  client: CompaniesHouseClient,
  companyNumber: string,
  options: PaginationOptions = {},
): Promise<PaginatedCompaniesHouseResource<NormalisedOfficer>> {
  return collectPaginatedResource({
    buildPath: buildCompanyOfficersPath,
    client,
    companyNumber,
    getItemId: (item) => item.id,
    normalisePage: normaliseOfficers,
    resourceName: "officers",
    ...paginationOptionsFromValues(options.itemsPerPage, options.startIndex),
  });
}

export async function fetchPersonsWithSignificantControl(
  client: CompaniesHouseClient,
  companyNumber: string,
  options: PaginationOptions = {},
): Promise<
  PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl>
> {
  return collectPaginatedResource({
    buildPath: buildPersonsWithSignificantControlPath,
    client,
    companyNumber,
    getItemId: (item) => item.id,
    normalisePage: normalisePersonsWithSignificantControl,
    resourceName: "persons with significant control",
    ...paginationOptionsFromValues(options.itemsPerPage, options.startIndex),
  });
}

export async function fetchCompanyCharges(
  client: CompaniesHouseClient,
  companyNumber: string,
  options: PaginationOptions = {},
): Promise<PaginatedCompaniesHouseResource<NormalisedCharge>> {
  return collectPaginatedResource({
    buildPath: buildCompanyChargesPath,
    client,
    companyNumber,
    getItemId: (item) => item.id,
    normalisePage: normaliseCharges,
    resourceName: "charges",
    ...paginationOptionsFromValues(options.itemsPerPage, options.startIndex),
  });
}

export async function fetchCompanyInsolvency(
  client: CompaniesHouseClient,
  companyNumber: string,
): Promise<NormalisedInsolvency> {
  const response = await client.requestJson(
    buildCompanyInsolvencyPath(companyNumber),
  );

  return normaliseInsolvency(
    response.data,
    createEvidenceRefFromResponse(response),
  );
}

export async function fetchCompanyFilingHistory(
  client: CompaniesHouseClient,
  companyNumber: string,
  options: PaginationOptions = {},
): Promise<PaginatedCompaniesHouseResource<NormalisedFilingHistoryItem>> {
  return collectPaginatedResource({
    buildPath: buildCompanyFilingHistoryPath,
    client,
    companyNumber,
    getItemId: (item) => item.id,
    normalisePage: normaliseFilingHistory,
    resourceName: "filing history",
    ...paginationOptionsFromValues(options.itemsPerPage, options.startIndex),
  });
}
