import { Buffer } from "node:buffer";
import { basename, resolve } from "node:path";

import type {
  CallToolResult,
  Tool,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";

import {
  buildCompanyDossier,
  type DossierClock,
  type DossierEndpointGateway,
  type DossierEndpointOutcome,
  type DossierEndpointResult,
} from "../app/dossier-service.js";
import {
  type CompaniesHouseClient,
  createCompaniesHouseClient,
} from "../companies-house/client.js";
import {
  fetchCompanyCharges,
  fetchCompanyFilingHistory,
  fetchCompanyInsolvency,
  fetchCompanyOfficers,
  fetchCompanyProfile,
  fetchPersonsWithSignificantControl,
  retrieveFilingDocument,
  type PaginatedCompaniesHouseResource,
  type RetrievedFilingDocument,
  type RetrieveFilingDocumentOptions,
} from "../companies-house/endpoints.js";
import {
  createEvidenceRef,
  normaliseCompanyNumber,
  type NormalisedFilingHistoryItem,
} from "../companies-house/normalise.js";
import type { ParsedEnvironment } from "../config/environment.js";
import {
  companyDossierSchema,
  type CompanyDossier,
  type EvidenceRef,
} from "../contracts/company-evidence.js";
import { DossierError, redactSecretText } from "../contracts/errors.js";
import { stableJsonStringify } from "../renderers/json-renderer.js";
import {
  compareDossierSnapshots,
  saveDossierSnapshot,
} from "../snapshots/store.js";

export type DossierMcpToolName =
  | "search_companies"
  | "build_company_dossier"
  | "list_company_filings"
  | "get_filing_document"
  | "save_dossier_snapshot"
  | "compare_dossier_snapshots";

type JsonSchemaProperty = Record<string, unknown>;
type JsonSchemaObject = Tool["inputSchema"] & {
  readonly additionalProperties: false;
  readonly properties: Record<string, JsonSchemaProperty>;
};

type ToolResultPayload = Record<string, unknown>;

type ToolHandler = (
  args: unknown,
  dependencies: DossierMcpToolDependencies,
) => Promise<ToolResultPayload>;

type McpToolErrorCode =
  | "document_safety_error"
  | "internal_error"
  | "invalid_input"
  | "service_unavailable"
  | "snapshot_error"
  | DossierError["code"];

export interface DossierMcpToolDefinition extends Tool {
  readonly annotations: ToolAnnotations;
  readonly inputSchema: JsonSchemaObject;
  readonly name: DossierMcpToolName;
}

export interface DossierMcpToolDependencies {
  readonly client?: CompaniesHouseClient;
  readonly clock?: DossierClock;
  readonly documentApiBaseUrl?: string;
  readonly environment?: ParsedEnvironment;
  readonly gateway?: DossierEndpointGateway;
  readonly maxDocumentBytes?: number;
  readonly maxSearchItemsPerPage?: number;
  readonly retrieveDocument?: (
    options: RetrieveFilingDocumentOptions,
  ) => Promise<RetrievedFilingDocument>;
}

interface RegisteredDossierMcpTool extends DossierMcpToolDefinition {
  readonly handler: ToolHandler;
}

interface NormalizedToolError {
  readonly code: McpToolErrorCode;
  readonly message: string;
}

const defaultMaxSearchItemsPerPage = 25;
const defaultMaxDocumentBytes = 4 * 1024 * 1024;
const documentIdPattern = /^[A-Za-z0-9_-]+$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const sectionKeys = [
  "profile",
  "officers",
  "pscs",
  "charges",
  "insolvency",
  "filings",
] as const;
const requestedDocumentContentTypes = [
  "application/pdf",
  "application/xhtml+xml",
] as const;
const publicRegisterLimitations =
  "Uses the Companies House public register only; results can be partial or unavailable when public endpoints omit data, rate-limit, or require live credentials/API key.";
const defaultMcpClock: DossierClock = {
  now: () => new Date(),
};

class McpToolInputError extends Error {
  public readonly code = "invalid_input" as const;
}

class McpToolServiceUnavailableError extends Error {
  public readonly code = "service_unavailable" as const;
}

function objectSchema(
  properties: Record<string, JsonSchemaProperty>,
  required: readonly string[],
): JsonSchemaObject {
  return {
    additionalProperties: false,
    properties,
    required: [...required],
    type: "object",
  };
}

const companyNumberProperty = {
  description:
    "Companies House company number. Whitespace is trimmed and letters are uppercased before validation.",
  minLength: 1,
  type: "string",
};
const snapshotDirProperty = {
  description: "Explicit local directory used for dossier snapshot files.",
  minLength: 1,
  type: "string",
};
const searchCompaniesInputSchema = objectSchema(
  {
    itemsPerPage: {
      description:
        "Optional requested page size. Values above the MCP cap are reduced.",
      minimum: 1,
      type: "integer",
    },
    query: {
      description: "Search text for Companies House company search.",
      minLength: 1,
      type: "string",
    },
  },
  ["query"],
);
const buildDossierInputSchema = objectSchema(
  {
    companyNumber: companyNumberProperty,
    sections: {
      description:
        "Optional list of dossier section keys to return from the built dossier.",
      items: {
        enum: [...sectionKeys],
        type: "string",
      },
      minItems: 1,
      type: "array",
      uniqueItems: true,
    },
  },
  ["companyNumber"],
);
const listFilingsInputSchema = objectSchema(
  {
    category: {
      description: "Optional Companies House filing category filter.",
      minLength: 1,
      type: "string",
    },
    companyNumber: companyNumberProperty,
    from: {
      description: "Optional inclusive lower filing date bound, YYYY-MM-DD.",
      format: "date",
      type: "string",
    },
    to: {
      description: "Optional inclusive upper filing date bound, YYYY-MM-DD.",
      format: "date",
      type: "string",
    },
  },
  ["companyNumber"],
);
const getFilingDocumentInputSchema = objectSchema(
  {
    documentId: {
      description:
        "Companies House document identifier without path separators.",
      minLength: 1,
      pattern: documentIdPattern.source,
      type: "string",
    },
    force: {
      description:
        "Overwrite an existing output file only when outputDirectory is supplied.",
      type: "boolean",
    },
    format: {
      description:
        "In-memory response format when no outputDirectory is supplied.",
      enum: ["metadata", "base64"],
      type: "string",
    },
    outputDirectory: {
      description:
        "Explicit local directory to write the document into. Omit to avoid filesystem writes.",
      minLength: 1,
      type: "string",
    },
    requestedContentType: {
      description:
        "Optional allowed content type: application/pdf or application/xhtml+xml.",
      enum: [...requestedDocumentContentTypes],
      type: "string",
    },
  },
  ["documentId"],
);
const saveSnapshotInputSchema = objectSchema(
  {
    dossier: {
      description:
        "A company dossier object that must satisfy the published evidence schema.",
      type: "object",
    },
    snapshotDir: snapshotDirProperty,
  },
  ["dossier", "snapshotDir"],
);
const compareSnapshotsInputSchema = objectSchema(
  {
    after: {
      description: "Later snapshot JSON basename located inside snapshotDir.",
      minLength: 1,
      type: "string",
    },
    before: {
      description: "Earlier snapshot JSON basename located inside snapshotDir.",
      minLength: 1,
      type: "string",
    },
    snapshotDir: snapshotDirProperty,
  },
  ["before", "after", "snapshotDir"],
);

const toolDefinitions: readonly RegisteredDossierMcpTool[] = [
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description: `Search Companies House public-register company records by text query. ${publicRegisterLimitations} Caps page size and returns source evidence for the search response.`,
    handler: searchCompanies,
    inputSchema: searchCompaniesInputSchema,
    name: "search_companies",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description: `Build a schema-valid company dossier with evidence sections from the Companies House public register. ${publicRegisterLimitations} Live API key credentials are required unless a fixture gateway is injected; section status shows complete, partial, unavailable, or not_applicable evidence.`,
    handler: buildDossier,
    inputSchema: buildDossierInputSchema,
    name: "build_company_dossier",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description: `List and filter Companies House public-register filing history for one company. ${publicRegisterLimitations} Live credentials are required unless a fixture gateway is injected, and returned items include evidence metadata.`,
    handler: listCompanyFilings,
    inputSchema: listFilingsInputSchema,
    name: "list_company_filings",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description: `Fetch filing document metadata/content from the Companies House public document register. ${publicRegisterLimitations} Without outputDirectory it returns bounded in-memory metadata or base64 content; it writes only when outputDirectory is explicitly supplied.`,
    handler: getFilingDocument,
    inputSchema: getFilingDocumentInputSchema,
    name: "get_filing_document",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: `Save one explicit local snapshot for a validated dossier built from Companies House public-register evidence. ${publicRegisterLimitations} This is the only snapshot-writing MCP tool and it requires snapshotDir.`,
    handler: saveSnapshot,
    inputSchema: saveSnapshotInputSchema,
    name: "save_dossier_snapshot",
  },
  {
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description: `Compare two existing dossier snapshots under one explicit snapshotDir without writing files. ${publicRegisterLimitations} Snapshot paths are confined to the supplied directory and comparison output preserves evidence-derived change metadata.`,
    handler: compareSnapshots,
    inputSchema: compareSnapshotsInputSchema,
    name: "compare_dossier_snapshots",
  },
];

function publicToolDefinition(
  tool: RegisteredDossierMcpTool,
): DossierMcpToolDefinition {
  return {
    annotations: tool.annotations,
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
  };
}

export function createDossierMcpTools(): readonly DossierMcpToolDefinition[] {
  return toolDefinitions.map(publicToolDefinition);
}

export async function executeDossierMcpTool(
  name: string,
  args: unknown,
  dependencies: DossierMcpToolDependencies = {},
): Promise<CallToolResult> {
  const tool = toolDefinitions.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    return errorResult({
      code: "invalid_input",
      message: `Unknown company dossier MCP tool: ${redactSecretText(name)}`,
    });
  }

  try {
    const payload = await tool.handler(args, dependencies);

    return successResult(payload);
  } catch (error) {
    return errorResult(normalizeToolError(error));
  }
}

function contentFromPayload(
  payload: ToolResultPayload,
): CallToolResult["content"] {
  return [
    {
      text: stableJsonStringify(payload),
      type: "text",
    },
  ];
}

function successResult(payload: ToolResultPayload): CallToolResult {
  const structuredContent = {
    ok: true,
    ...payload,
  };

  return {
    content: contentFromPayload(structuredContent),
    structuredContent,
  };
}

function errorResult(error: NormalizedToolError): CallToolResult {
  const structuredContent = {
    error,
    ok: false,
  };

  return {
    content: contentFromPayload(structuredContent),
    isError: true,
    structuredContent,
  };
}

function normalizeToolError(error: unknown): NormalizedToolError {
  if (error instanceof McpToolInputError) {
    return {
      code: error.code,
      message: redactSecretText(error.message),
    };
  }

  if (error instanceof McpToolServiceUnavailableError) {
    return {
      code: error.code,
      message: redactSecretText(error.message),
    };
  }

  if (error instanceof DossierError) {
    return {
      code: error.code,
      message: redactSecretText(error.message),
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: redactSecretText(error.message),
    };
  }

  return {
    code: "internal_error",
    message: redactSecretText(String(error)),
  };
}

function parseArgs(
  args: unknown,
  schema: JsonSchemaObject,
): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new McpToolInputError("Tool arguments must be a JSON object.");
  }

  const record = args as Record<string, unknown>;
  const allowedProperties = new Set(Object.keys(schema.properties));

  for (const key of Object.keys(record)) {
    if (!allowedProperties.has(key)) {
      throw new McpToolInputError(
        `Unknown argument "${key}" is not allowed for this tool.`,
      );
    }
  }

  for (const key of schema.required ?? []) {
    if (!(key in record)) {
      throw new McpToolInputError(`Required argument "${key}" is missing.`);
    }
  }

  return record;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpToolInputError(
      `Argument "${key}" must be a non-empty string.`,
    );
  }

  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpToolInputError(
      `Argument "${key}" must be a non-empty string.`,
    );
  }

  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new McpToolInputError(`Argument "${key}" must be a boolean.`);
  }

  return value;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new McpToolInputError(
      `Argument "${key}" must be a positive integer.`,
    );
  }

  return value;
}

function optionalEnum<TValue extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly TValue[],
): TValue | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !values.includes(value as TValue)) {
    throw new McpToolInputError(
      `Argument "${key}" must be one of: ${values.join(", ")}.`,
    );
  }

  return value as TValue;
}

function optionalSectionList(
  record: Record<string, unknown>,
): readonly (typeof sectionKeys)[number][] | undefined {
  const value = record.sections;

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new McpToolInputError(
      'Argument "sections" must be a non-empty array of section keys.',
    );
  }

  const seen = new Set<string>();
  const sections: (typeof sectionKeys)[number][] = [];

  for (const item of value) {
    if (typeof item !== "string" || !sectionKeys.includes(item as never)) {
      throw new McpToolInputError(
        `Argument "sections" contains an unsupported section key.`,
      );
    }

    if (seen.has(item)) {
      throw new McpToolInputError(
        'Argument "sections" must not contain duplicate section keys.',
      );
    }

    seen.add(item);
    sections.push(item as (typeof sectionKeys)[number]);
  }

  return sections;
}

function parseCompanyNumber(value: string): string {
  try {
    return normaliseCompanyNumber(value);
  } catch (error) {
    throw new McpToolInputError(
      error instanceof Error
        ? error.message
        : "Invalid Companies House company number.",
    );
  }
}

function parseDateBound(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isIsoCalendarDate(value)) {
    throw new McpToolInputError(`${label} must use YYYY-MM-DD format.`);
  }

  return value;
}

function isIsoCalendarDate(value: string): boolean {
  if (!isoDatePattern.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDocumentId(value: string): string {
  const trimmed = value.trim();

  if (!documentIdPattern.test(trimmed)) {
    throw new McpToolInputError(
      "Document ID must be a non-empty identifier without path separators.",
    );
  }

  return trimmed;
}

function parseSnapshotDir(value: string): string {
  if (value.trim().length === 0) {
    throw new McpToolInputError("snapshotDir must be an explicit directory.");
  }

  return value;
}

function parseSnapshotFileName(value: string, label: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0 || basename(trimmed) !== trimmed) {
    throw new McpToolInputError(
      `${label} must be a snapshot JSON basename inside snapshotDir.`,
    );
  }

  return trimmed;
}

function requestedPageSize(
  value: number | undefined,
  dependencies: DossierMcpToolDependencies,
): number {
  const cap =
    dependencies.maxSearchItemsPerPage ?? defaultMaxSearchItemsPerPage;

  if (!Number.isInteger(cap) || cap < 1) {
    throw new McpToolInputError("Search page size cap must be positive.");
  }

  return Math.min(value ?? cap, cap);
}

function requestedDocumentMaxBytes(
  dependencies: DossierMcpToolDependencies,
): number {
  const maxBytes = dependencies.maxDocumentBytes ?? defaultMaxDocumentBytes;

  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new McpToolInputError("Document byte cap must be positive.");
  }

  return maxBytes;
}

function documentClock(
  clock: DossierClock | undefined,
): { readonly now: () => Date } | undefined {
  if (clock === undefined) {
    return undefined;
  }

  return {
    now: () => {
      const value = clock.now();

      return value instanceof Date ? value : new Date(value);
    },
  };
}

function resolveClient(
  dependencies: DossierMcpToolDependencies,
): CompaniesHouseClient {
  if (dependencies.client !== undefined) {
    return dependencies.client;
  }

  const environment = dependencies.environment;

  if (environment?.apiKeyConfigured !== true) {
    throw new McpToolServiceUnavailableError(
      "Companies House API key is required for live MCP tool calls.",
    );
  }

  return createCompaniesHouseClient({
    apiBaseUrl: environment.apiBaseUrl,
    getApiKey: () => environment.getApiKey(),
  });
}

function resolveGateway(
  dependencies: DossierMcpToolDependencies,
): DossierEndpointGateway {
  if (dependencies.gateway !== undefined) {
    return dependencies.gateway;
  }

  const client = resolveClient(dependencies);

  return {
    fetchCompanyCharges: (companyNumber) =>
      fetchCompanyCharges(client, companyNumber),
    fetchCompanyFilingHistory: (companyNumber) =>
      fetchCompanyFilingHistory(client, companyNumber),
    fetchCompanyInsolvency: (companyNumber) =>
      fetchCompanyInsolvency(client, companyNumber),
    fetchCompanyOfficers: (companyNumber) =>
      fetchCompanyOfficers(client, companyNumber),
    fetchCompanyProfile: (companyNumber) =>
      fetchCompanyProfile(client, companyNumber),
    fetchPersonsWithSignificantControl: (companyNumber) =>
      fetchPersonsWithSignificantControl(client, companyNumber),
  };
}

function isEndpointOutcome<TResource>(
  value: DossierEndpointResult<TResource>,
): value is DossierEndpointOutcome<TResource> {
  const kind =
    typeof value === "object" && value !== null && "kind" in value
      ? (value as { readonly kind?: unknown }).kind
      : undefined;

  return (
    kind === "available" || kind === "partial" || kind === "not_applicable"
  );
}

function unwrapFilings(
  result: DossierEndpointResult<
    PaginatedCompaniesHouseResource<NormalisedFilingHistoryItem>
  >,
  companyNumber: string,
): {
  readonly evidence: readonly EvidenceRef[];
  readonly items: readonly NormalisedFilingHistoryItem[];
  readonly warnings: readonly string[];
} {
  if (isEndpointOutcome(result)) {
    if (result.kind === "not_applicable") {
      return {
        evidence: result.evidence,
        items: [],
        warnings: [result.reason],
      };
    }

    return {
      evidence: result.resource.evidence,
      items: result.resource.items,
      warnings: [
        ...result.resource.warnings,
        ...(result.kind === "partial" ? result.warnings : []),
      ],
    };
  }

  return {
    evidence: result.evidence,
    items: result.items,
    warnings: result.companyNumber === companyNumber ? result.warnings : [],
  };
}

function filterFilings(
  items: readonly NormalisedFilingHistoryItem[],
  filters: {
    readonly category?: string;
    readonly from?: string;
    readonly to?: string;
  },
): readonly NormalisedFilingHistoryItem[] {
  return items.filter((item) => {
    if (filters.category !== undefined && item.category !== filters.category) {
      return false;
    }

    if (
      filters.from !== undefined &&
      (item.date === undefined || item.date < filters.from)
    ) {
      return false;
    }

    if (
      filters.to !== undefined &&
      (item.date === undefined || item.date > filters.to)
    ) {
      return false;
    }

    return true;
  });
}

function filtersFromArgs(record: Record<string, unknown>): {
  readonly category?: string;
  readonly from?: string;
  readonly to?: string;
} {
  const category = optionalString(record, "category")?.trim();
  const from = parseDateBound(optionalString(record, "from"), "from");
  const to = parseDateBound(optionalString(record, "to"), "to");

  if (from !== undefined && to !== undefined && from > to) {
    throw new McpToolInputError("from must be earlier than or equal to to.");
  }

  return {
    ...(category !== undefined ? { category } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

function filterDossierSections(
  dossier: CompanyDossier,
  sections: readonly string[] | undefined,
): CompanyDossier {
  if (sections === undefined) {
    return dossier;
  }

  const selectedSections: CompanyDossier["sections"] = {};

  for (const section of sections) {
    const value = dossier.sections[section];

    if (value !== undefined) {
      selectedSections[section] = value;
    }
  }

  return companyDossierSchema.parse({
    ...dossier,
    sections: selectedSections,
  });
}

function parseDossierArgument(value: unknown): CompanyDossier {
  const result = companyDossierSchema.safeParse(value);

  if (!result.success) {
    throw new McpToolInputError(
      'Argument "dossier" must satisfy the company evidence schema.',
    );
  }

  return result.data;
}

function stringValue(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function numberValue(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function normaliseSearchItems(
  data: unknown,
  limit: number,
): readonly ToolResultPayload[] {
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as { readonly items?: unknown }).items)
  ) {
    return [];
  }

  return (data as { readonly items: readonly unknown[] }).items
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    .map((item) => ({
      ...(stringValue(item, "company_name") !== undefined
        ? { companyName: stringValue(item, "company_name") }
        : {}),
      ...(stringValue(item, "company_number") !== undefined
        ? { companyNumber: stringValue(item, "company_number") }
        : {}),
      ...(stringValue(item, "company_status") !== undefined
        ? { companyStatus: stringValue(item, "company_status") }
        : {}),
      ...(stringValue(item, "company_type") !== undefined
        ? { companyType: stringValue(item, "company_type") }
        : {}),
    }))
    .slice(0, limit);
}

async function searchCompanies(
  args: unknown,
  dependencies: DossierMcpToolDependencies,
): Promise<ToolResultPayload> {
  const record = parseArgs(args, searchCompaniesInputSchema);
  const query = requiredString(record, "query").trim();
  const itemsPerPage = requestedPageSize(
    optionalPositiveInteger(record, "itemsPerPage"),
    dependencies,
  );
  const searchParams = new URLSearchParams([
    ["q", query],
    ["items_per_page", String(itemsPerPage)],
  ]);
  const path = `/search/companies?${searchParams.toString()}`;
  const client = resolveClient(dependencies);
  const response = await client.requestJson(path);
  const evidence = createEvidenceRef({
    rawBytes: response.rawBytes,
    retrievedAt: response.retrievedAt,
    sourceUri: response.finalUrl,
  });
  const data =
    typeof response.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>)
      : {};

  return {
    evidence: [evidence],
    items: normaliseSearchItems(response.data, itemsPerPage),
    itemsPerPage,
    query,
    ...(numberValue(data, "total_results") !== undefined
      ? { totalResults: numberValue(data, "total_results") }
      : {}),
  };
}

async function buildDossier(
  args: unknown,
  dependencies: DossierMcpToolDependencies,
): Promise<ToolResultPayload> {
  const record = parseArgs(args, buildDossierInputSchema);
  const companyNumber = parseCompanyNumber(
    requiredString(record, "companyNumber"),
  );
  const sections = optionalSectionList(record);
  const dossier = await buildCompanyDossier({
    clock: dependencies.clock ?? defaultMcpClock,
    companyNumber,
    gateway: resolveGateway(dependencies),
  });

  return {
    dossier: filterDossierSections(dossier, sections),
  };
}

async function listCompanyFilings(
  args: unknown,
  dependencies: DossierMcpToolDependencies,
): Promise<ToolResultPayload> {
  const record = parseArgs(args, listFilingsInputSchema);
  const companyNumber = parseCompanyNumber(
    requiredString(record, "companyNumber"),
  );
  const filters = filtersFromArgs(record);
  const gateway = resolveGateway(dependencies);
  const result = unwrapFilings(
    await gateway.fetchCompanyFilingHistory(companyNumber),
    companyNumber,
  );

  return {
    companyNumber,
    evidence: result.evidence,
    filters,
    items: filterFilings(result.items, filters),
    warnings: result.warnings,
  };
}

async function getFilingDocument(
  args: unknown,
  dependencies: DossierMcpToolDependencies,
): Promise<ToolResultPayload> {
  const record = parseArgs(args, getFilingDocumentInputSchema);
  const documentId = parseDocumentId(requiredString(record, "documentId"));
  const format =
    optionalEnum(record, "format", ["metadata", "base64"] as const) ??
    "metadata";
  const outputDirectory = optionalString(record, "outputDirectory");
  const requestedContentType = optionalEnum(
    record,
    "requestedContentType",
    requestedDocumentContentTypes,
  );
  const resolvedDocumentApiBaseUrl =
    dependencies.documentApiBaseUrl ??
    dependencies.environment?.documentApiBaseUrl;
  const resolvedDocumentClock = documentClock(dependencies.clock);
  const request: RetrieveFilingDocumentOptions = {
    client: resolveClient(dependencies),
    documentId,
    force: optionalBoolean(record, "force") === true,
    maxBytes: requestedDocumentMaxBytes(dependencies),
    ...(resolvedDocumentClock !== undefined
      ? { clock: resolvedDocumentClock }
      : {}),
    ...(resolvedDocumentApiBaseUrl !== undefined
      ? { documentApiBaseUrl: resolvedDocumentApiBaseUrl }
      : {}),
    ...(requestedContentType !== undefined ? { requestedContentType } : {}),
    ...(outputDirectory !== undefined ? { outputDirectory } : {}),
  };
  const result = await (
    dependencies.retrieveDocument ?? retrieveFilingDocument
  )(request);
  const metadata = {
    byteLength: result.bytes.byteLength,
    contentType: result.contentType,
    documentId: result.documentId,
    filePath: result.filePath,
    retrievedAt: result.retrievedAt,
    sha256: result.sha256,
    sourceUri: result.sourceUri,
  };

  return {
    ...metadata,
    ...(format === "base64" && outputDirectory === undefined
      ? {
          content: {
            base64: Buffer.from(result.bytes).toString("base64"),
            encoding: "base64",
          },
        }
      : {}),
  };
}

async function saveSnapshot(args: unknown): Promise<ToolResultPayload> {
  const record = parseArgs(args, saveSnapshotInputSchema);
  const snapshotDir = parseSnapshotDir(requiredString(record, "snapshotDir"));
  const dossier = parseDossierArgument(record.dossier);

  return {
    metadata: await saveDossierSnapshot({
      dossier,
      snapshotDir,
    }),
  };
}

async function compareSnapshots(args: unknown): Promise<ToolResultPayload> {
  const record = parseArgs(args, compareSnapshotsInputSchema);
  const snapshotDir = parseSnapshotDir(requiredString(record, "snapshotDir"));
  const beforeFileName = parseSnapshotFileName(
    requiredString(record, "before"),
    "before",
  );
  const afterFileName = parseSnapshotFileName(
    requiredString(record, "after"),
    "after",
  );
  const root = resolve(snapshotDir);

  return {
    comparison: await compareDossierSnapshots({
      afterFileName: basename(resolve(root, afterFileName)),
      beforeFileName: basename(resolve(root, beforeFileName)),
      snapshotDir,
    }),
  };
}
