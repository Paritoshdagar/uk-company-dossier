import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  type CompaniesHouseClient,
  type CompaniesHouseJsonResponse,
} from "./client.js";
import {
  buildFilingDocumentMetadataPath,
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
import {
  CompaniesHouseHttpError,
  DocumentSafetyError,
} from "../contracts/errors.js";

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

export type FilingDocumentAllowedContentType =
  | "application/pdf"
  | "application/xhtml+xml";

export type FilingDocumentBody =
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>
  | ReadableStream<Uint8Array>;

export interface FilingDocumentContentRequest {
  readonly accept: FilingDocumentAllowedContentType;
  readonly url: URL;
}

export interface FilingDocumentContentResponse {
  readonly body: FilingDocumentBody;
  readonly contentLength?: number | undefined;
  readonly contentType?: string | undefined;
  readonly finalUrl: string;
}

export interface FilingDocumentContentFetcher {
  fetch(
    request: FilingDocumentContentRequest,
  ): Promise<FilingDocumentContentResponse>;
}

export interface FilingDocumentWriteRequest {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly force: boolean;
  readonly outputDirectory: string;
}

export interface FilingDocumentWriter {
  writeAtomic(
    request: FilingDocumentWriteRequest,
  ): Promise<{ readonly filePath: string }>;
}

export interface RetrieveFilingDocumentOptions {
  readonly client: CompaniesHouseClient;
  readonly clock?: {
    now(): Date;
  };
  readonly contentFetcher: FilingDocumentContentFetcher;
  readonly documentApiBaseUrl?: string;
  readonly documentId?: string;
  readonly documentMetadataLink?: string;
  readonly force?: boolean;
  readonly maxBytes?: number;
  readonly outputDirectory?: string;
  readonly requestedContentType?: string;
  readonly suggestedFilename?: string;
  readonly writer?: FilingDocumentWriter;
}

export interface RetrievedFilingDocument {
  readonly bytes: Uint8Array;
  readonly contentType: FilingDocumentAllowedContentType;
  readonly documentId: string;
  readonly filePath: string | undefined;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly sourceUri: string;
}

const defaultItemsPerPage = 25;
const defaultDocumentApiBaseUrl =
  "https://document-api.company-information.service.gov.uk";
const defaultMaxDocumentBytes = 20 * 1024 * 1024;
const allowedDocumentContentTypes = [
  "application/pdf",
  "application/xhtml+xml",
] as const satisfies readonly FilingDocumentAllowedContentType[];

const nodeFilingDocumentWriter: FilingDocumentWriter = {
  async writeAtomic(
    request: FilingDocumentWriteRequest,
  ): Promise<{ readonly filePath: string }> {
    await mkdir(request.outputDirectory, { recursive: true });

    const outputDirectory = resolve(request.outputDirectory);
    const filePath = resolve(outputDirectory, request.filename);
    const tempPath = join(
      outputDirectory,
      `.${request.filename}.${randomUUID()}.tmp`,
    );

    if (!isPathInsideDirectory(filePath, outputDirectory)) {
      throw new DocumentSafetyError(
        "Filing document output path escaped the configured output directory.",
      );
    }

    if (!request.force && (await pathExists(filePath))) {
      throw new DocumentSafetyError(
        "Filing document output file already exists. Pass force to overwrite it.",
      );
    }

    try {
      await writeFile(tempPath, request.bytes, { flag: "wx" });

      if (!request.force && (await pathExists(filePath))) {
        throw new DocumentSafetyError(
          "Filing document output file already exists. Pass force to overwrite it.",
        );
      }

      await rename(tempPath, filePath);

      return { filePath };
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);

      if (error instanceof DocumentSafetyError) {
        throw error;
      }

      if (isFileExistsError(error)) {
        throw new DocumentSafetyError(
          "Filing document output file already exists. Pass force to overwrite it.",
          { cause: error },
        );
      }

      throw error;
    }
  },
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new CompaniesHouseHttpError(
      `${label} must be a positive integer for Companies House pagination.`,
    );
  }

  return value;
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  return (
    filePath === directory ||
    filePath.startsWith(
      directory.endsWith(sep) ? directory : `${directory}${sep}`,
    )
  );
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

function documentSafetyError(message: string): DocumentSafetyError {
  return new DocumentSafetyError(message);
}

function resolveMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? defaultMaxDocumentBytes;

  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw documentSafetyError(
      "Filing document maximum byte length must be a positive integer.",
    );
  }

  return maxBytes;
}

function documentIdFromMetadataPath(metadataPath: string): string {
  const prefix = "/document/";

  if (!metadataPath.startsWith(prefix)) {
    throw documentSafetyError(
      "Filing document metadata path did not contain a document identifier.",
    );
  }

  return decodeURIComponent(metadataPath.slice(prefix.length));
}

function normaliseDocumentContentType(
  value: string | undefined,
): FilingDocumentAllowedContentType | undefined {
  if (value === undefined) {
    return undefined;
  }

  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();

  return allowedDocumentContentTypes.find(
    (contentType) => contentType === mediaType,
  );
}

function recordValue(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = value[key];

  return isRecord(nested) ? nested : undefined;
}

function stringValue(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = value[key];

  return typeof nested === "string" && nested.trim().length > 0
    ? nested
    : undefined;
}

function numberValue(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = value[key];

  if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) {
    return nested;
  }

  if (typeof nested === "string" && nested.trim().length > 0) {
    const parsed = Number(nested);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  return undefined;
}

function validateContentLength(
  contentLength: number | undefined,
  maxBytes: number,
  label: string,
): void {
  if (contentLength === undefined) {
    return;
  }

  if (!Number.isInteger(contentLength) || contentLength < 0) {
    throw documentSafetyError(
      `Filing document ${label} contained an invalid Content-Length.`,
    );
  }

  if (contentLength > maxBytes) {
    throw documentSafetyError(
      `Filing document ${label} exceeded the configured maximum byte length.`,
    );
  }
}

function resourcesRecord(metadata: unknown): Record<string, unknown> {
  const resources = recordValue(metadata, "resources");

  if (resources === undefined) {
    throw documentSafetyError(
      "Filing document metadata did not advertise downloadable resources.",
    );
  }

  return resources;
}

function resourceForContentType(
  resources: Record<string, unknown>,
  contentType: FilingDocumentAllowedContentType,
): unknown {
  return Object.entries(resources).find(
    ([resourceContentType]) =>
      normaliseDocumentContentType(resourceContentType) === contentType,
  )?.[1];
}

function selectDocumentContentType(
  metadata: unknown,
  requestedContentType: string | undefined,
  maxBytes: number,
): FilingDocumentAllowedContentType {
  const requested = normaliseDocumentContentType(requestedContentType);

  if (requestedContentType !== undefined && requested === undefined) {
    throw documentSafetyError(
      "Requested filing document content type is not allowed.",
    );
  }

  const resources = resourcesRecord(metadata);
  const selected =
    requested ??
    allowedDocumentContentTypes.find(
      (contentType) =>
        resourceForContentType(resources, contentType) !== undefined,
    );

  if (selected === undefined) {
    throw documentSafetyError(
      "Filing document metadata did not include an allowed downloadable content type.",
    );
  }

  const resource = resourceForContentType(resources, selected);

  if (resource === undefined) {
    throw documentSafetyError(
      "Requested filing document content type is not available for this document.",
    );
  }

  validateContentLength(
    numberValue(resource, "content_length"),
    maxBytes,
    "metadata resource",
  );

  return selected;
}

function ensureDocumentApiOrigin(url: URL, baseUrl: URL, label: string): void {
  if (url.origin !== baseUrl.origin) {
    throw documentSafetyError(
      `Filing document ${label} must stay within the configured Companies House document API host.`,
    );
  }
}

function documentContentUrl(metadata: unknown, baseUrl: URL): URL {
  const links = recordValue(metadata, "links");
  const documentLink = stringValue(links, "document");

  if (documentLink === undefined) {
    throw documentSafetyError(
      "Filing document metadata did not include a document content link.",
    );
  }

  const url = new URL(documentLink, baseUrl);

  ensureDocumentApiOrigin(url, baseUrl, "content URL");

  return url;
}

function extensionForContentType(
  contentType: FilingDocumentAllowedContentType,
): string {
  return contentType === "application/pdf" ? ".pdf" : ".xhtml";
}

function sanitiseFilingDocumentFilename(filename: string): string {
  const trimmed = filename.trim();

  if (trimmed.length === 0) {
    throw documentSafetyError("Filing document filename must not be empty.");
  }

  if (trimmed.includes("\0")) {
    throw documentSafetyError("Filing document filename must not contain NUL.");
  }

  if (
    isAbsolute(trimmed) ||
    /^[A-Za-z]:[\\/]/u.test(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw documentSafetyError(
      "Filing document filename must be a safe basename, not a path.",
    );
  }

  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw documentSafetyError(
      "Filing document filename must not contain parent directory traversal.",
    );
  }

  const sanitised = trimmed.replaceAll(/[^A-Za-z0-9._-]/gu, "_");

  if (
    sanitised.length === 0 ||
    sanitised === "." ||
    sanitised === ".." ||
    sanitised.includes("..")
  ) {
    throw documentSafetyError("Filing document filename is not safe.");
  }

  return sanitised;
}

function filenameForDocument(
  documentId: string,
  contentType: FilingDocumentAllowedContentType,
  suggestedFilename: string | undefined,
): string {
  return sanitiseFilingDocumentFilename(
    suggestedFilename ?? `${documentId}${extensionForContentType(contentType)}`,
  );
}

async function* chunksFromReadableStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();

  try {
    for (;;) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isReadableStream(
  body: FilingDocumentBody,
): body is ReadableStream<Uint8Array> {
  return (
    typeof body === "object" &&
    typeof (body as { readonly getReader?: unknown }).getReader === "function"
  );
}

async function boundedDocumentBytes(
  body: FilingDocumentBody,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const iterable = isReadableStream(body)
    ? chunksFromReadableStream(body)
    : body;

  for await (const chunk of iterable) {
    byteLength += chunk.byteLength;

    if (byteLength > maxBytes) {
      throw documentSafetyError(
        "Filing document body exceeded the configured maximum byte length.",
      );
    }

    chunks.push(chunk);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
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

export async function retrieveFilingDocument(
  options: RetrieveFilingDocumentOptions,
): Promise<RetrievedFilingDocument> {
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const documentApiBaseUrl = new URL(
    options.documentApiBaseUrl ?? defaultDocumentApiBaseUrl,
  );
  const metadataPathInput: {
    documentId?: string;
    documentMetadataLink?: string;
  } = {};

  if (options.documentId !== undefined) {
    metadataPathInput.documentId = options.documentId;
  }

  if (options.documentMetadataLink !== undefined) {
    metadataPathInput.documentMetadataLink = options.documentMetadataLink;
  }

  const metadataPath = buildFilingDocumentMetadataPath(metadataPathInput);
  const documentId = documentIdFromMetadataPath(metadataPath);
  const metadataResponse =
    await options.client.requestJson<Record<string, unknown>>(metadataPath);
  const contentType = selectDocumentContentType(
    metadataResponse.data,
    options.requestedContentType,
    maxBytes,
  );
  const contentUrl = documentContentUrl(
    metadataResponse.data,
    documentApiBaseUrl,
  );
  const filename =
    options.outputDirectory === undefined
      ? undefined
      : filenameForDocument(documentId, contentType, options.suggestedFilename);
  const contentResponse = await options.contentFetcher.fetch({
    accept: contentType,
    url: contentUrl,
  });
  const finalUrl = new URL(contentResponse.finalUrl, documentApiBaseUrl);

  ensureDocumentApiOrigin(finalUrl, documentApiBaseUrl, "final URL");
  validateContentLength(
    contentResponse.contentLength,
    maxBytes,
    "Content-Length",
  );

  const responseContentType = normaliseDocumentContentType(
    contentResponse.contentType,
  );

  if (responseContentType !== contentType) {
    throw documentSafetyError(
      "Filing document response content type was not the requested allowed content type.",
    );
  }

  const bytes = await boundedDocumentBytes(contentResponse.body, maxBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const retrievedAt =
    options.clock?.now().toISOString() ?? metadataResponse.retrievedAt;
  const filePath =
    options.outputDirectory === undefined || filename === undefined
      ? undefined
      : (
          await (options.writer ?? nodeFilingDocumentWriter).writeAtomic({
            bytes,
            filename,
            force: options.force === true,
            outputDirectory: options.outputDirectory,
          })
        ).filePath;

  return {
    bytes,
    contentType,
    documentId,
    filePath,
    retrievedAt,
    sha256,
    sourceUri: finalUrl.toString(),
  };
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
