import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type {
  CompaniesHouseBytesRequestOptions,
  CompaniesHouseBytesResponse,
  CompaniesHouseClient,
  CompaniesHouseJsonResponse,
} from "../../src/companies-house/client.js";
import type { PaginatedCompaniesHouseResource } from "../../src/companies-house/endpoints.js";
import type {
  NormalisedCharge,
  NormalisedCompanyProfile,
  NormalisedFilingHistoryItem,
  NormalisedInsolvency,
  NormalisedOfficer,
  NormalisedPersonWithSignificantControl,
} from "../../src/companies-house/normalise.js";
import {
  companyDossierSchema,
  type EvidenceRef,
} from "../../src/contracts/company-evidence.js";
import type {
  DossierEndpointGateway,
  DossierEndpointResult,
} from "../../src/app/dossier-service.js";
import {
  createDossierMcpTools,
  executeDossierMcpTool,
} from "../../src/mcp/tools.js";

const companyNumber = "SC123456";
const generatedAt = "2026-06-21T12:00:00.000Z";
const retrievedAt = "2026-06-21T11:59:00.000Z";
const apiBaseUrl = "https://api.company-information.service.gov.uk";
const documentApiBaseUrl =
  "https://document-api.company-information.service.gov.uk";
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const expectedToolNames = [
  "search_companies",
  "build_company_dossier",
  "list_company_filings",
  "get_filing_document",
  "save_dossier_snapshot",
  "compare_dossier_snapshots",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

type ToolName = (typeof expectedToolNames)[number];
type ToolDefinitions = ReturnType<typeof createDossierMcpTools>;

class QueueCompaniesHouseClient implements CompaniesHouseClient {
  public readonly byteRequests: {
    readonly accept: string | undefined;
    readonly request: string;
  }[] = [];
  public readonly jsonRequests: string[] = [];
  readonly #pendingBytes: CompaniesHouseBytesResponse[];
  readonly #pendingJson: CompaniesHouseJsonResponse[];

  public constructor(
    jsonResponses: readonly CompaniesHouseJsonResponse[] = [],
    byteResponses: readonly CompaniesHouseBytesResponse[] = [],
  ) {
    this.#pendingJson = [...jsonResponses];
    this.#pendingBytes = [...byteResponses];
  }

  public requestJson<TData = unknown>(
    pathOrUrl: string | URL,
  ): Promise<CompaniesHouseJsonResponse<TData>> {
    const request = pathOrUrl instanceof URL ? pathOrUrl.toString() : pathOrUrl;

    this.jsonRequests.push(request);

    const next = this.#pendingJson.shift();

    if (next === undefined) {
      return Promise.reject(
        new Error(`Unexpected extra JSON request: ${request}`),
      );
    }

    return Promise.resolve(next as CompaniesHouseJsonResponse<TData>);
  }

  public requestBytes(
    pathOrUrl: string | URL,
    options: CompaniesHouseBytesRequestOptions = {},
  ): Promise<CompaniesHouseBytesResponse> {
    const request = pathOrUrl instanceof URL ? pathOrUrl.toString() : pathOrUrl;

    this.byteRequests.push({ accept: options.accept, request });

    const next = this.#pendingBytes.shift();

    if (next === undefined) {
      return Promise.reject(
        new Error(`Unexpected extra byte request: ${request}`),
      );
    }

    return Promise.resolve(next);
  }
}

function evidence(path: string): EvidenceRef {
  return {
    payloadSha256:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    retrievedAt,
    sourceUri: `${apiBaseUrl}${path}`,
  };
}

function available<TResource>(
  resource: TResource,
): DossierEndpointResult<TResource> {
  return {
    kind: "available",
    resource,
  };
}

function unavailableResult<TResource>(): Promise<
  DossierEndpointResult<TResource>
> {
  return Promise.reject(new Error("fixture endpoint unavailable"));
}

function paginatedResource<TItem>(
  items: readonly TItem[],
): PaginatedCompaniesHouseResource<TItem> {
  return {
    companyNumber,
    evidence: [evidence("/company/SC123456/filing-history")],
    items,
    warnings: [],
  };
}

function filingItem(
  overrides: Partial<NormalisedFilingHistoryItem> = {},
): NormalisedFilingHistoryItem {
  return {
    category: "accounts",
    date: "2026-01-15",
    description: "accounts-with-accounts-type-full",
    documentMetadataPath: "/document/doc-pdf-001",
    evidence: evidence("/company/SC123456/filing-history"),
    id: "MzAwOTk5",
    paperFiled: false,
    type: "AA",
    ...overrides,
  };
}

function profile(): NormalisedCompanyProfile {
  return {
    companyName: "ALPHA-BETA HOLDINGS LIMITED",
    companyNumber,
    companyStatus: "active",
    dateOfCreation: "2020-01-02",
    evidence: evidence("/company/SC123456"),
    registeredOfficeAddress: {
      addressLine1: "1 Evidence Street",
      country: "Scotland",
      postalCode: "EH1 1AA",
    },
    sicCodes: [],
    type: "ltd",
  };
}

function fixtureGateway(): DossierEndpointGateway {
  return {
    fetchCompanyCharges: () =>
      unavailableResult<PaginatedCompaniesHouseResource<NormalisedCharge>>(),
    fetchCompanyFilingHistory: () =>
      Promise.resolve(
        available(
          paginatedResource([
            filingItem(),
            filingItem({
              category: "confirmation-statement",
              date: "2025-05-01",
              description: "confirmation-statement",
              documentMetadataPath: "/document/doc-cs-001",
              id: "MzAxMDAw",
              type: "CS01",
            }),
          ]),
        ),
      ),
    fetchCompanyInsolvency: () => unavailableResult<NormalisedInsolvency>(),
    fetchCompanyOfficers: () =>
      unavailableResult<PaginatedCompaniesHouseResource<NormalisedOfficer>>(),
    fetchCompanyProfile: () => Promise.resolve(available(profile())),
    fetchPersonsWithSignificantControl: () =>
      unavailableResult<
        PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl>
      >(),
  };
}

function jsonResponse(
  path: string,
  data: unknown,
  baseUrl = apiBaseUrl,
): CompaniesHouseJsonResponse {
  const rawText = JSON.stringify(data);
  const rawBytes = Buffer.from(rawText, "utf8");

  return {
    data,
    finalUrl: `${baseUrl}${path}`,
    headers: {
      "content-type": "application/json",
    },
    rawBytes,
    rawText,
    requestedUrl: `${baseUrl}${path}`,
    retrievedAt,
    status: 200,
  };
}

function documentBytesResponse(bytes: Uint8Array): CompaniesHouseBytesResponse {
  return {
    body: [bytes],
    contentLength: bytes.byteLength,
    contentType: "application/pdf",
    finalUrl: `${documentApiBaseUrl}/document/doc-pdf-001/content`,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": "application/pdf",
    },
    requestedUrl: `${documentApiBaseUrl}/document/doc-pdf-001/content`,
    retrievedAt,
    status: 200,
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dossier-mcp-"));

  temporaryDirectories.push(directory);

  return directory;
}

function toolByName(tools: ToolDefinitions, name: ToolName) {
  const tool = tools.find((candidate) => candidate.name === name);

  expect(tool).toBeDefined();

  return tool;
}

function expectJsonObject(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  expect(Array.isArray(value)).toBe(false);

  return value as Record<string, unknown>;
}

function expectString(value: unknown): string {
  expect(typeof value).toBe("string");

  return value as string;
}

function expectArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);

  return value as unknown[];
}

async function createStdioFixtureEntrypoint(): Promise<{
  readonly loaderPath: string;
  readonly scriptPath: string;
}> {
  const directory = await temporaryDirectory();
  const loaderPath = join(directory, "source-loader.mjs");
  const scriptPath = join(directory, "fixture-server.mjs");
  const serverUrl = pathToFileURL(join(projectRoot, "src/mcp/server.ts")).href;
  const stdioTransportUrl = pathToFileURL(
    join(
      projectRoot,
      "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
    ),
  ).href;
  const typescriptUrl = pathToFileURL(
    join(projectRoot, "node_modules/typescript/lib/typescript.js"),
  ).href;
  const loaderSource = `
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from ${JSON.stringify(typescriptUrl)};

const projectRoot = ${JSON.stringify(projectRoot)};
const projectPrefix = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;

function sourceUrl(specifier, parentURL) {
  let url;

  try {
    if (specifier.startsWith("file:")) {
      url = new URL(specifier);
    } else if (isAbsolute(specifier)) {
      url = pathToFileURL(specifier);
    } else if (specifier.startsWith(".") && parentURL !== undefined) {
      url = new URL(specifier, parentURL);
    }
  } catch {
    return undefined;
  }

  if (url?.protocol !== "file:") {
    return undefined;
  }

  const path = fileURLToPath(url);

  if (path !== projectRoot && !path.startsWith(projectPrefix)) {
    return undefined;
  }

  if (path.endsWith(".ts") && existsSync(path)) {
    return pathToFileURL(path).href;
  }

  if (!path.endsWith(".js")) {
    return undefined;
  }

  const candidate = path.slice(0, -3) + ".ts";

  return existsSync(candidate) ? pathToFileURL(candidate).href : undefined;
}

export async function resolve(specifier, context, defaultResolve) {
  const mapped = sourceUrl(specifier, context.parentURL);

  if (mapped !== undefined) {
    return { shortCircuit: true, url: mapped };
  }

  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
      },
    });

    return {
      format: "module",
      shortCircuit: true,
      source: transpiled.outputText,
    };
  }

  return defaultLoad(url, context, defaultLoad);
}
`;
  const scriptSource = `
import { StdioServerTransport } from ${JSON.stringify(stdioTransportUrl)};
import { startDossierMcpServer } from ${JSON.stringify(serverUrl)};

const companyNumber = ${JSON.stringify(companyNumber)};
const generatedAt = ${JSON.stringify(generatedAt)};
const retrievedAt = ${JSON.stringify(retrievedAt)};
const apiBaseUrl = ${JSON.stringify(apiBaseUrl)};
const payloadSha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function evidence(path) {
  return {
    payloadSha256,
    retrievedAt,
    sourceUri: apiBaseUrl + path,
  };
}

function available(resource) {
  return { kind: "available", resource };
}

function unavailableResult() {
  return Promise.reject(new Error("fixture endpoint unavailable"));
}

function paginatedResource(items) {
  return {
    companyNumber,
    evidence: [evidence("/company/SC123456/filing-history")],
    items,
    warnings: [],
  };
}

const profile = {
  companyName: "ALPHA-BETA HOLDINGS LIMITED",
  companyNumber,
  companyStatus: "active",
  dateOfCreation: "2020-01-02",
  evidence: evidence("/company/SC123456"),
  registeredOfficeAddress: {
    addressLine1: "1 Evidence Street",
    country: "Scotland",
    postalCode: "EH1 1AA",
  },
  sicCodes: [],
  type: "ltd",
};
const filing = {
  category: "accounts",
  date: "2026-01-15",
  description: "accounts-with-accounts-type-full",
  documentMetadataPath: "/document/doc-pdf-001",
  evidence: evidence("/company/SC123456/filing-history"),
  id: "MzAwOTk5",
  paperFiled: false,
  type: "AA",
};
const gateway = {
  fetchCompanyCharges: () => unavailableResult(),
  fetchCompanyFilingHistory: () =>
    Promise.resolve(available(paginatedResource([filing]))),
  fetchCompanyInsolvency: () => unavailableResult(),
  fetchCompanyOfficers: () => unavailableResult(),
  fetchCompanyProfile: () => Promise.resolve(available(profile)),
  fetchPersonsWithSignificantControl: () => unavailableResult(),
};

await startDossierMcpServer({
  clock: { now: () => new Date(generatedAt) },
  gateway,
  logger: (message) => {
    process.stderr.write(String(message) + "\\n");
  },
  registerProcessSignals: false,
  transport: new StdioServerTransport(),
});
`;

  await writeFile(loaderPath, loaderSource);
  await writeFile(scriptPath, scriptSource);

  return { loaderPath, scriptPath };
}

describe("company dossier MCP tool contracts", () => {
  it("defines six bounded tools with strict JSON Schema inputs and safe descriptions", () => {
    const tools = createDossierMcpTools();

    expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);

    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({
        additionalProperties: false,
        type: "object",
      });
      expect(tool.description).toMatch(/Companies House|public register/iu);
      expect(tool.description).toMatch(/credentials|API key|live/iu);
      expect(tool.description).toMatch(/partial|unavailable|evidence/iu);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties.unexpected).toBeUndefined();
    }

    expect(toolByName(tools, "search_companies").annotations.readOnlyHint).toBe(
      true,
    );
    expect(
      toolByName(tools, "build_company_dossier").annotations.readOnlyHint,
    ).toBe(true);
    expect(
      toolByName(tools, "list_company_filings").annotations.readOnlyHint,
    ).toBe(true);
    expect(
      toolByName(tools, "get_filing_document").annotations.readOnlyHint,
    ).toBe(false);
    expect(
      toolByName(tools, "save_dossier_snapshot").annotations.readOnlyHint,
    ).toBe(false);
    expect(
      toolByName(tools, "compare_dossier_snapshots").annotations.readOnlyHint,
    ).toBe(true);

    expect(toolByName(tools, "search_companies").inputSchema).toMatchObject({
      required: ["query"],
    });
    expect(
      toolByName(tools, "build_company_dossier").inputSchema,
    ).toMatchObject({
      required: ["companyNumber"],
    });
    expect(
      toolByName(tools, "save_dossier_snapshot").inputSchema,
    ).toMatchObject({
      required: ["dossier", "snapshotDir"],
    });
    expect(
      toolByName(tools, "compare_dossier_snapshots").inputSchema,
    ).toMatchObject({
      required: ["before", "after", "snapshotDir"],
    });
  });

  it("rejects invalid company numbers as structured safe input errors", async () => {
    const result = await executeDossierMcpTool(
      "build_company_dossier",
      {
        companyNumber: "bad",
      },
      {
        clock: { now: () => new Date(generatedAt) },
        gateway: fixtureGateway(),
      },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "invalid_input",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("rejects unknown properties as structured safe tool errors", async () => {
    const secret = "authorization: Bearer should-not-leak";
    const result = await executeDossierMcpTool(
      "build_company_dossier",
      {
        companyNumber: "bad",
        apiKey: secret,
      },
      {
        clock: { now: () => new Date(generatedAt) },
        gateway: fixtureGateway(),
      },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "invalid_input",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("redacts unknown tool names before returning structured tool errors", async () => {
    const result = await executeDossierMcpTool(
      "missing authorization: Bearer should-not-leak",
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "invalid_input",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("should-not-leak");
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("builds schema-valid dossier evidence through the shared dossier service", async () => {
    const result = await executeDossierMcpTool(
      "build_company_dossier",
      {
        companyNumber: " sc123456 ",
      },
      {
        clock: { now: () => new Date(generatedAt) },
        gateway: fixtureGateway(),
      },
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      dossier: {
        company: {
          companyNumber,
          registeredName: "ALPHA-BETA HOLDINGS LIMITED",
        },
        generatedAt,
      },
      ok: true,
    });

    const dossier = result.structuredContent?.dossier;

    expect(companyDossierSchema.safeParse(dossier).success).toBe(true);
    expect(JSON.stringify(dossier)).toContain("fixture endpoint unavailable");
  });

  it("lists filtered filings with evidence and requires explicit paths for mutating writes", async () => {
    const result = await executeDossierMcpTool(
      "list_company_filings",
      {
        category: "accounts",
        companyNumber,
        from: "2026-01-01",
        to: "2026-12-31",
      },
      {
        gateway: fixtureGateway(),
      },
    );

    expect(result.structuredContent).toMatchObject({
      companyNumber,
      filters: {
        category: "accounts",
        from: "2026-01-01",
        to: "2026-12-31",
      },
      items: [
        {
          id: "MzAwOTk5",
          type: "AA",
        },
      ],
      ok: true,
    });

    const documentBytes = Buffer.from("%PDF-1.4\nfixture\n%%EOF\n");
    const client = new QueueCompaniesHouseClient(
      [
        jsonResponse(
          "/document/doc-pdf-001",
          {
            links: {
              document: "/document/doc-pdf-001/content",
            },
            resources: {
              "application/pdf": {
                content_length: documentBytes.byteLength,
              },
            },
          },
          documentApiBaseUrl,
        ),
      ],
      [documentBytesResponse(documentBytes)],
    );
    const documentResult = await executeDossierMcpTool(
      "get_filing_document",
      {
        documentId: "doc-pdf-001",
        format: "base64",
      },
      {
        client,
        documentApiBaseUrl,
        maxDocumentBytes: 4096,
      },
    );

    expect(documentResult.structuredContent).toMatchObject({
      content: {
        base64: Buffer.from(documentBytes).toString("base64"),
        encoding: "base64",
      },
      documentId: "doc-pdf-001",
      filePath: undefined,
      ok: true,
      sha256: sha256Hex(documentBytes),
    });
    expect(client.byteRequests).toEqual([
      {
        accept: "application/pdf",
        request: `${documentApiBaseUrl}/document/doc-pdf-001/content`,
      },
    ]);
  });

  it("rejects impossible filing date filters as structured input errors", async () => {
    const result = await executeDossierMcpTool(
      "list_company_filings",
      {
        companyNumber,
        from: "2026-02-31",
      },
      {
        gateway: fixtureGateway(),
      },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "invalid_input",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("saves one explicit dossier snapshot and confines snapshot comparison to the snapshot directory", async () => {
    const snapshotDir = await temporaryDirectory();
    const dossierResult = await executeDossierMcpTool(
      "build_company_dossier",
      { companyNumber },
      {
        clock: { now: () => new Date(generatedAt) },
        gateway: fixtureGateway(),
      },
    );
    const dossier = dossierResult.structuredContent?.dossier;
    const saveResult = await executeDossierMcpTool("save_dossier_snapshot", {
      dossier,
      snapshotDir,
    });

    expect(saveResult.structuredContent).toMatchObject({
      metadata: {
        companyNumber,
      },
      ok: true,
    });

    const saveContent = expectJsonObject(saveResult.structuredContent);
    const metadata = expectJsonObject(saveContent.metadata);
    const fileName = expectString(metadata.fileName);

    expect(fileName).not.toContain("/");

    const savedPath = expectString(metadata.path);

    await expect(readFile(savedPath, "utf8")).resolves.toContain(companyNumber);

    const compareResult = await executeDossierMcpTool(
      "compare_dossier_snapshots",
      {
        after: fileName,
        before: fileName,
        snapshotDir,
      },
    );

    expect(compareResult.structuredContent).toMatchObject({
      comparison: {
        afterFileName: fileName,
        beforeFileName: fileName,
      },
      ok: true,
    });

    const escapedCompareResult = await executeDossierMcpTool(
      "compare_dossier_snapshots",
      {
        after: "../escape.json",
        before: fileName,
        snapshotDir,
      },
    );

    expect(escapedCompareResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "invalid_input",
        },
        ok: false,
      },
    });
  });

  it("rejects invalid supplied dossiers for snapshots as structured input errors", async () => {
    const result = await executeDossierMcpTool("save_dossier_snapshot", {
      dossier: {},
      snapshotDir: await temporaryDirectory(),
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "invalid_input",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("internal_error");
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("rejects unsupported document content types at the MCP boundary", async () => {
    const client = new QueueCompaniesHouseClient([
      jsonResponse(
        "/document/doc-pdf-001",
        {
          links: {
            document: "/document/doc-pdf-001/content",
          },
          resources: {
            "application/pdf": {
              content_length: 100,
            },
          },
        },
        documentApiBaseUrl,
      ),
    ]);
    const result = await executeDossierMcpTool(
      "get_filing_document",
      {
        documentId: "doc-pdf-001",
        requestedContentType: "text/html",
      },
      {
        client,
        documentApiBaseUrl,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "invalid_input",
      },
      ok: false,
    });
    expect(client.jsonRequests).toEqual([]);
    expect(client.byteRequests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("caps search page size and document byte size", async () => {
    const searchClient = new QueueCompaniesHouseClient([
      jsonResponse("/search/companies?q=alpha&items_per_page=25", {
        items: [
          {
            company_name: "ALPHA-BETA HOLDINGS LIMITED",
            company_number: companyNumber,
            company_status: "active",
            company_type: "ltd",
          },
        ],
        items_per_page: 25,
        page_number: 1,
        total_results: 1,
      }),
    ]);
    const searchResult = await executeDossierMcpTool(
      "search_companies",
      {
        itemsPerPage: 500,
        query: "alpha",
      },
      {
        client: searchClient,
        maxSearchItemsPerPage: 25,
      },
    );

    expect(searchResult.structuredContent).toMatchObject({
      items: [
        {
          companyName: "ALPHA-BETA HOLDINGS LIMITED",
          companyNumber,
        },
      ],
      itemsPerPage: 25,
      ok: true,
      query: "alpha",
    });
    expect(searchClient.jsonRequests).toEqual([
      "/search/companies?q=alpha&items_per_page=25",
    ]);

    const oversizedDocumentResult = await executeDossierMcpTool(
      "get_filing_document",
      {
        documentId: "doc-pdf-001",
      },
      {
        client: new QueueCompaniesHouseClient([
          jsonResponse(
            "/document/doc-pdf-001",
            {
              links: {
                document: "/document/doc-pdf-001/content",
              },
              resources: {
                "application/pdf": {
                  content_length: 5000,
                },
              },
            },
            documentApiBaseUrl,
          ),
        ]),
        documentApiBaseUrl,
        maxDocumentBytes: 4096,
      },
    );

    expect(oversizedDocumentResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "document_safety_error",
        },
        ok: false,
      },
    });
  });

  it("caps returned search items even when upstream sends extra results", async () => {
    const searchClient = new QueueCompaniesHouseClient([
      jsonResponse("/search/companies?q=alpha&items_per_page=1", {
        items: [
          {
            company_name: "ALPHA-BETA HOLDINGS LIMITED",
            company_number: companyNumber,
            company_status: "active",
            company_type: "ltd",
          },
          {
            company_name: "EXTRA RESULT LIMITED",
            company_number: "SC654321",
            company_status: "active",
            company_type: "ltd",
          },
        ],
        items_per_page: 1,
        page_number: 1,
        total_results: 2,
      }),
    ]);
    const result = await executeDossierMcpTool(
      "search_companies",
      {
        query: "alpha",
      },
      {
        client: searchClient,
        maxSearchItemsPerPage: 1,
      },
    );
    const content = expectJsonObject(result.structuredContent);
    const items = expectArray(content.items);

    expect(result.isError).toBeUndefined();
    expect(content).toMatchObject({
      itemsPerPage: 1,
      ok: true,
    });
    expect(items).toHaveLength(1);
    expect(items.at(0)).toMatchObject({
      companyName: "ALPHA-BETA HOLDINGS LIMITED",
      companyNumber,
    });
  });
});

describe("company dossier MCP stdio server", () => {
  it("lists tools and serves fixture-backed dossier evidence over official stdio transport", async () => {
    const { loaderPath, scriptPath } = await createStdioFixtureEntrypoint();
    const scriptUrl = pathToFileURL(scriptPath).href;
    const client = new Client({
      name: "uk-company-dossier-test-client",
      version: "0.1.0",
    });
    const transport = new StdioClientTransport({
      args: [
        "--experimental-loader",
        loaderPath,
        "--input-type=module",
        "--eval",
        `import(${JSON.stringify(scriptUrl)});`,
      ],
      command: process.execPath,
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? "",
      },
      stderr: "pipe",
    });
    const stderrChunks: string[] = [];

    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });

    try {
      await client.connect(transport);

      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name)).toEqual(expectedToolNames);

      const result = await client.callTool({
        arguments: {
          companyNumber,
        },
        name: "build_company_dossier",
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        dossier: {
          company: {
            companyNumber,
          },
        },
        ok: true,
      });
      expect(
        companyDossierSchema.safeParse(result.structuredContent?.dossier)
          .success,
      ).toBe(true);
    } catch (error) {
      const stderr = stderrChunks.join("");

      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nChild stderr:\n${stderr}`,
      );
    } finally {
      await client.close();
    }
  });
});
