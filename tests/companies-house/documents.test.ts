import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type CompaniesHouseBytesRequestOptions,
  type CompaniesHouseBytesResponse,
  type CompaniesHouseClient,
  type CompaniesHouseJsonResponse,
} from "../../src/companies-house/client.js";
import {
  retrieveFilingDocument,
  type FilingDocumentWriter,
} from "../../src/companies-house/endpoints.js";
import { DocumentSafetyError } from "../../src/contracts/errors.js";

const documentApiBaseUrl =
  "https://document-api.company-information.service.gov.uk";
const retrievedAt = "2026-02-03T04:05:06.789Z";

class QueueCompaniesHouseClient implements CompaniesHouseClient {
  public readonly byteRequests: {
    readonly accept: string | undefined;
    readonly request: string;
  }[] = [];
  public readonly jsonRequests: string[] = [];
  readonly #operations: string[];
  readonly #pendingBytes: CompaniesHouseBytesResponse[];
  readonly #pendingJson: CompaniesHouseJsonResponse[];

  public constructor(
    jsonResponses: readonly CompaniesHouseJsonResponse[],
    byteResponses: readonly CompaniesHouseBytesResponse[] = [],
    operations: string[] = [],
  ) {
    this.#operations = operations;
    this.#pendingBytes = [...byteResponses];
    this.#pendingJson = [...jsonResponses];
  }

  public requestJson<TData = unknown>(
    pathOrUrl: string | URL,
  ): Promise<CompaniesHouseJsonResponse<TData>> {
    const request = pathOrUrl instanceof URL ? pathOrUrl.toString() : pathOrUrl;
    this.jsonRequests.push(request);
    this.#operations.push(`metadata:${request}`);

    const next = this.#pendingJson.shift();

    if (next === undefined) {
      return Promise.reject(
        new Error("Unexpected extra Companies House metadata request."),
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
    this.#operations.push(
      `content:${request}:${options.accept ?? "application/octet-stream"}`,
    );

    const next = this.#pendingBytes.shift();

    if (next === undefined) {
      return Promise.reject(
        new Error("Unexpected extra Companies House document content request."),
      );
    }

    return Promise.resolve(next);
  }
}

class ThrowingDocumentWriter implements FilingDocumentWriter {
  public writeAtomic(): Promise<{ readonly filePath: string }> {
    return Promise.reject(new Error("Document writer should not be called."));
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

function fixtureText(name: string): string {
  return readFileSync(
    new URL(`../fixtures/companies-house/${name}`, import.meta.url),
    "utf8",
  );
}

function fixtureBytes(name: string): Uint8Array {
  return readFileSync(
    new URL(`../fixtures/companies-house/${name}`, import.meta.url),
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function metadataResponse(
  data: unknown = JSON.parse(fixtureText("document-metadata.json")) as unknown,
): CompaniesHouseJsonResponse {
  const rawText = JSON.stringify(data);
  const rawBytes = Buffer.from(rawText, "utf8");

  return {
    data,
    finalUrl: `${documentApiBaseUrl}/document/doc-pdf-001`,
    headers: {
      "content-type": "application/json",
    },
    rawBytes,
    rawText,
    requestedUrl: `${documentApiBaseUrl}/document/doc-pdf-001`,
    retrievedAt,
    status: 200,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "uk-company-dossier-documents-"),
  );

  temporaryDirectories.push(directory);

  return directory;
}

function contentResponse(
  bytes: Uint8Array = fixtureBytes("document.pdf"),
  overrides: Partial<CompaniesHouseBytesResponse> = {},
): CompaniesHouseBytesResponse {
  return {
    body: [bytes],
    contentLength: bytes.byteLength,
    contentType: "application/pdf; charset=binary",
    finalUrl: `${documentApiBaseUrl}/document/doc-pdf-001/content`,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": "application/pdf; charset=binary",
    },
    requestedUrl: `${documentApiBaseUrl}/document/doc-pdf-001/content`,
    retrievedAt,
    status: 200,
    ...overrides,
  };
}

describe("Companies House filing document retrieval", () => {
  it("obtains metadata before content, requests an allowed content type, and returns bytes in memory by default", async () => {
    const operations: string[] = [];
    const documentBytes = fixtureBytes("document.pdf");
    const client = new QueueCompaniesHouseClient(
      [metadataResponse()],
      [contentResponse(documentBytes)],
      operations,
    );

    const result = await retrieveFilingDocument({
      client,
      clock: { now: () => new Date(retrievedAt) },
      documentApiBaseUrl,
      documentId: "doc-pdf-001",
      maxBytes: 4096,
      writer: new ThrowingDocumentWriter(),
    });

    expect(operations).toEqual([
      "metadata:/document/doc-pdf-001",
      `content:${documentApiBaseUrl}/document/doc-pdf-001/content:application/pdf`,
    ]);
    expect(client.byteRequests).toEqual([
      {
        accept: "application/pdf",
        request: `${documentApiBaseUrl}/document/doc-pdf-001/content`,
      },
    ]);
    expect(result).toMatchObject({
      contentType: "application/pdf",
      documentId: "doc-pdf-001",
      filePath: undefined,
      retrievedAt,
      sha256: sha256Hex(documentBytes),
      sourceUri: `${documentApiBaseUrl}/document/doc-pdf-001/content`,
    });
    expect([...result.bytes]).toEqual([...documentBytes]);
  });

  it("can explicitly request XHTML but rejects content types outside the allowed set", async () => {
    const xhtmlBytes = Buffer.from(
      "<html><body>Document</body></html>",
      "utf8",
    );
    const xhtmlClient = new QueueCompaniesHouseClient(
      [metadataResponse()],
      [
        contentResponse(xhtmlBytes, {
          body: [xhtmlBytes],
          contentLength: xhtmlBytes.byteLength,
          contentType: "application/xhtml+xml; charset=utf-8",
        }),
      ],
    );

    await expect(
      retrieveFilingDocument({
        client: xhtmlClient,
        clock: { now: () => new Date(retrievedAt) },
        documentApiBaseUrl,
        documentId: "doc-pdf-001",
        maxBytes: 4096,
        requestedContentType: "application/xhtml+xml",
      }),
    ).resolves.toMatchObject({
      contentType: "application/xhtml+xml",
      sha256: sha256Hex(xhtmlBytes),
    });
    expect(xhtmlClient.byteRequests.map((request) => request.accept)).toEqual([
      "application/xhtml+xml",
    ]);

    await expect(
      retrieveFilingDocument({
        client: new QueueCompaniesHouseClient([metadataResponse()]),
        documentApiBaseUrl,
        documentId: "doc-pdf-001",
        requestedContentType: "text/html",
      }),
    ).rejects.toBeInstanceOf(DocumentSafetyError);
  });

  it("rejects oversized documents from Content-Length before reading bytes", async () => {
    const client = new QueueCompaniesHouseClient(
      [metadataResponse()],
      [
        contentResponse(fixtureBytes("document.pdf"), {
          contentLength: 4097,
        }),
      ],
    );

    await expect(
      retrieveFilingDocument({
        client,
        documentApiBaseUrl,
        documentId: "doc-pdf-001",
        maxBytes: 4096,
      }),
    ).rejects.toBeInstanceOf(DocumentSafetyError);
  });

  it("rejects oversized documents from streamed byte count", async () => {
    const firstChunk = Buffer.alloc(3000, "a");
    const secondChunk = Buffer.alloc(2000, "b");

    await expect(
      retrieveFilingDocument({
        client: new QueueCompaniesHouseClient(
          [metadataResponse()],
          [
            contentResponse(Buffer.concat([firstChunk, secondChunk]), {
              body: [firstChunk, secondChunk],
              contentLength: undefined,
            }),
          ],
        ),
        documentApiBaseUrl,
        documentId: "doc-pdf-001",
        maxBytes: 4096,
      }),
    ).rejects.toBeInstanceOf(DocumentSafetyError);
  });

  it("refuses redirects to hosts outside the configured document API host", async () => {
    await expect(
      retrieveFilingDocument({
        client: new QueueCompaniesHouseClient(
          [metadataResponse()],
          [
            contentResponse(fixtureBytes("document.pdf"), {
              finalUrl: "https://evil.example/document/doc-pdf-001/content",
            }),
          ],
        ),
        documentApiBaseUrl,
        documentId: "doc-pdf-001",
        maxBytes: 4096,
      }),
    ).rejects.toBeInstanceOf(DocumentSafetyError);
  });

  it("sanitises safe suggested filenames and rejects path injection", async () => {
    const outputDirectory = await temporaryDirectory();
    const documentBytes = fixtureBytes("document.pdf");

    const result = await retrieveFilingDocument({
      client: new QueueCompaniesHouseClient(
        [metadataResponse()],
        [contentResponse(documentBytes)],
      ),
      documentApiBaseUrl,
      documentId: "doc-pdf-001",
      maxBytes: 4096,
      outputDirectory,
      suggestedFilename: " Confirmation Statement 2024?.pdf ",
    });

    expect(basename(result.filePath ?? "")).toBe(
      "Confirmation_Statement_2024_.pdf",
    );
    await expect(readFile(result.filePath ?? "")).resolves.toEqual(
      Buffer.from(documentBytes),
    );

    for (const unsafeFilename of [
      "../escape.pdf",
      "/tmp/escape.pdf",
      "nested/name.pdf",
      "nested\\name.pdf",
      "nul\u0000byte.pdf",
      "..",
    ]) {
      await expect(
        retrieveFilingDocument({
          client: new QueueCompaniesHouseClient([metadataResponse()]),
          documentApiBaseUrl,
          documentId: "doc-pdf-001",
          outputDirectory,
          suggestedFilename: unsafeFilename,
        }),
      ).rejects.toBeInstanceOf(DocumentSafetyError);
    }
  });

  it("uses atomic create-and-rename and refuses overwrite unless force is explicit", async () => {
    const outputDirectory = await temporaryDirectory();
    const documentBytes = fixtureBytes("document.pdf");

    const initial = await retrieveFilingDocument({
      client: new QueueCompaniesHouseClient(
        [metadataResponse()],
        [contentResponse(documentBytes)],
      ),
      documentApiBaseUrl,
      documentId: "doc-pdf-001",
      maxBytes: 4096,
      outputDirectory,
      suggestedFilename: "document.pdf",
    });

    await expect(
      retrieveFilingDocument({
        client: new QueueCompaniesHouseClient(
          [metadataResponse()],
          [contentResponse(documentBytes)],
        ),
        documentApiBaseUrl,
        documentId: "doc-pdf-001",
        maxBytes: 4096,
        outputDirectory,
        suggestedFilename: "document.pdf",
      }),
    ).rejects.toBeInstanceOf(DocumentSafetyError);

    const replacementBytes = Buffer.from("%PDF-1.4\nreplacement\n%%EOF\n");
    const replacement = await retrieveFilingDocument({
      client: new QueueCompaniesHouseClient(
        [metadataResponse()],
        [contentResponse(replacementBytes)],
      ),
      documentApiBaseUrl,
      documentId: "doc-pdf-001",
      force: true,
      maxBytes: 4096,
      outputDirectory,
      suggestedFilename: "document.pdf",
    });

    expect(initial.filePath).toBe(join(outputDirectory, "document.pdf"));
    expect(replacement.filePath).toBe(initial.filePath);
    await expect(readFile(replacement.filePath ?? "")).resolves.toEqual(
      replacementBytes,
    );
  });

  it("refuses a non-force write if the final path appears during atomic finalization", async () => {
    const { createFilingDocumentWriter } =
      await import("../../src/companies-house/endpoints.js");

    const outputDirectory = await temporaryDirectory();
    const finalPath = join(outputDirectory, "document.pdf");
    const racingBytes = Buffer.from("racing writer\n", "utf8");
    const writer = createFilingDocumentWriter({
      beforeFinalize: async ({ filePath }) => {
        expect(filePath).toBe(finalPath);
        await writeFile(filePath, racingBytes, { flag: "wx" });
      },
    });

    await expect(
      retrieveFilingDocument({
        client: new QueueCompaniesHouseClient(
          [metadataResponse()],
          [contentResponse(fixtureBytes("document.pdf"))],
        ),
        documentApiBaseUrl,
        documentId: "doc-pdf-001",
        maxBytes: 4096,
        outputDirectory,
        suggestedFilename: "document.pdf",
        writer,
      }),
    ).rejects.toBeInstanceOf(DocumentSafetyError);
    await expect(readFile(finalPath)).resolves.toEqual(racingBytes);
  });
});
