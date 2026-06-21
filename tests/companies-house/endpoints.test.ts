import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type CompaniesHouseClient,
  type CompaniesHouseJsonResponse,
} from "../../src/companies-house/client.js";
import {
  buildCompanyChargesPath,
  buildCompanyFilingHistoryPath,
  buildCompanyInsolvencyPath,
  buildCompanyOfficersPath,
  buildCompanyProfilePath,
  buildFilingDocumentMetadataPath,
  buildPersonsWithSignificantControlPath,
  fetchCompanyCharges,
  fetchCompanyFilingHistory,
  fetchCompanyInsolvency,
  fetchCompanyOfficers,
  fetchCompanyProfile,
  fetchPersonsWithSignificantControl,
} from "../../src/companies-house/endpoints.js";
import {
  CompaniesHouseHttpError,
  ResourceNotFoundError,
} from "../../src/contracts/errors.js";

const apiBaseUrl = "https://api.company-information.service.gov.uk";
const retrievedAt = "2026-02-03T04:05:06.789Z";

class QueueCompaniesHouseClient implements CompaniesHouseClient {
  public readonly requests: string[] = [];
  readonly #pending: (CompaniesHouseJsonResponse | Error)[];

  public constructor(
    responses: readonly (CompaniesHouseJsonResponse | Error)[],
  ) {
    this.#pending = [...responses];
  }

  public requestJson<TData = unknown>(
    pathOrUrl: string | URL,
  ): Promise<CompaniesHouseJsonResponse<TData>> {
    this.requests.push(
      pathOrUrl instanceof URL ? pathOrUrl.toString() : pathOrUrl,
    );

    const next = this.#pending.shift();

    if (next === undefined) {
      return Promise.reject(
        new Error("Unexpected extra Companies House request."),
      );
    }

    if (next instanceof Error) {
      return Promise.reject(next);
    }

    return Promise.resolve(next as CompaniesHouseJsonResponse<TData>);
  }
}

function fixtureText(name: string): string {
  return readFileSync(
    new URL(`../fixtures/companies-house/${name}`, import.meta.url),
    "utf8",
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseFromText(
  path: string,
  rawText: string,
): CompaniesHouseJsonResponse {
  const rawBytes = Buffer.from(rawText, "utf8");
  const sourceUri = `${apiBaseUrl}${path}`;

  return {
    data: JSON.parse(rawText) as unknown,
    finalUrl: sourceUri,
    headers: {
      "content-type": "application/json",
    },
    rawBytes,
    rawText,
    requestedUrl: sourceUri,
    retrievedAt,
    status: 200,
  };
}

function responseFromData(
  path: string,
  data: unknown,
): CompaniesHouseJsonResponse {
  return responseFromText(path, JSON.stringify(data));
}

describe("Companies House endpoint path builders", () => {
  it("trims, uppercases, and validates alphanumeric company numbers", () => {
    expect(buildCompanyProfilePath(" sc123456 ")).toBe("/company/SC123456");
    expect(buildCompanyProfilePath(" oc000001 ")).toBe("/company/OC000001");
    expect(() => buildCompanyProfilePath("1234567")).toThrow(
      /company number/iu,
    );
    expect(() => buildCompanyProfilePath("SC/12345")).toThrow(
      /company number/iu,
    );
  });

  it("builds official resource paths with URLSearchParams pagination", () => {
    const pagination = new URLSearchParams([
      ["items_per_page", "25"],
      ["start_index", "10"],
    ]).toString();

    expect(buildCompanyProfilePath("SC123456")).toBe("/company/SC123456");
    expect(
      buildCompanyOfficersPath("SC123456", {
        itemsPerPage: 25,
        startIndex: 10,
      }),
    ).toBe(`/company/SC123456/officers?${pagination}`);
    expect(
      buildPersonsWithSignificantControlPath("SC123456", {
        itemsPerPage: 25,
        startIndex: 10,
      }),
    ).toBe(`/company/SC123456/persons-with-significant-control?${pagination}`);
    expect(
      buildCompanyChargesPath("SC123456", {
        itemsPerPage: 25,
        startIndex: 10,
      }),
    ).toBe(`/company/SC123456/charges?${pagination}`);
    expect(buildCompanyInsolvencyPath("SC123456")).toBe(
      "/company/SC123456/insolvency",
    );
    expect(
      buildCompanyFilingHistoryPath("SC123456", {
        itemsPerPage: 25,
        startIndex: 10,
      }),
    ).toBe(`/company/SC123456/filing-history?${pagination}`);
  });

  it("represents filing document metadata as a safe path builder without fetching bytes", () => {
    expect(
      buildFilingDocumentMetadataPath({
        documentMetadataLink:
          "https://document-api.company-information.service.gov.uk/document/doc with spaces",
      }),
    ).toBe("/document/doc%20with%20spaces");
    expect(buildFilingDocumentMetadataPath({ documentId: "abc/123" })).toBe(
      "/document/abc%2F123",
    );
  });
});

describe("Companies House endpoint collection", () => {
  it("collects company profile data with one evidence reference over exact raw bytes", async () => {
    const rawText = fixtureText("profile.json");
    const response = responseFromText("/company/SC123456", rawText);
    const client = new QueueCompaniesHouseClient([response]);

    const profile = await fetchCompanyProfile(client, " sc123456 ");

    expect(client.requests).toEqual(["/company/SC123456"]);
    expect(profile).toMatchObject({
      companyName: "ALPHA-BETA HOLDINGS LIMITED",
      companyNumber: "SC123456",
      companyStatus: "active",
      dateOfCreation: "2020-01-02",
      type: "ltd",
    });
    expect(profile).not.toHaveProperty("undocumented_nested_field");
    expect(profile.evidence).toEqual({
      payloadSha256: sha256Hex(response.rawBytes),
      retrievedAt,
      sourceUri: `${apiBaseUrl}/company/SC123456`,
    });
  });

  it("paginates by returned item count, stops at total_results, de-duplicates stable identifiers, and records page evidence", async () => {
    const page1Path = buildCompanyOfficersPath("SC123456", {
      itemsPerPage: 2,
      startIndex: 0,
    });
    const page2Path = buildCompanyOfficersPath("SC123456", {
      itemsPerPage: 2,
      startIndex: 2,
    });
    const page1 = responseFromText(
      page1Path,
      fixtureText("officers-page-1.json"),
    );
    const page2 = responseFromText(
      page2Path,
      fixtureText("officers-page-2.json"),
    );
    const client = new QueueCompaniesHouseClient([page1, page2]);

    const result = await fetchCompanyOfficers(client, "SC123456", {
      itemsPerPage: 2,
    });

    expect(client.requests).toEqual([page1Path, page2Path]);
    expect(result.items.map((item) => item.id)).toEqual([
      "appt-001",
      "appt-002",
      "appt-003",
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining("appt-002") as string,
    ]);
    expect(result.evidence).toEqual([
      {
        payloadSha256: sha256Hex(page1.rawBytes),
        retrievedAt,
        sourceUri: `${apiBaseUrl}${page1Path}`,
      },
      {
        payloadSha256: sha256Hex(page2.rawBytes),
        retrievedAt,
        sourceUri: `${apiBaseUrl}${page2Path}`,
      },
    ]);
    expect(result.items.at(2)?.evidence).toEqual(result.evidence.at(1));
  });

  it("terminates pagination safely on an empty page when upstream totals are inconsistent", async () => {
    const pagePath = buildCompanyOfficersPath("SC123456", {
      itemsPerPage: 2,
      startIndex: 0,
    });
    const client = new QueueCompaniesHouseClient([
      responseFromData(pagePath, {
        items: [],
        items_per_page: 2,
        start_index: 0,
        total_results: 10,
      }),
    ]);

    const result = await fetchCompanyOfficers(client, "SC123456", {
      itemsPerPage: 2,
    });

    expect(client.requests).toEqual([pagePath]);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("empty page") as string,
    ]);
  });

  it("collects PSC, charges, insolvency, and filing history from their documented resource paths", async () => {
    const pscPath = buildPersonsWithSignificantControlPath("SC123456", {
      itemsPerPage: 25,
      startIndex: 0,
    });
    const chargesPath = buildCompanyChargesPath("SC123456", {
      itemsPerPage: 25,
      startIndex: 0,
    });
    const insolvencyPath = buildCompanyInsolvencyPath("SC123456");
    const filingPath = buildCompanyFilingHistoryPath("SC123456", {
      itemsPerPage: 25,
      startIndex: 0,
    });
    const pscClient = new QueueCompaniesHouseClient([
      responseFromText(pscPath, fixtureText("psc.json")),
    ]);
    const chargesClient = new QueueCompaniesHouseClient([
      responseFromText(chargesPath, fixtureText("charges.json")),
    ]);
    const insolvencyClient = new QueueCompaniesHouseClient([
      responseFromData(insolvencyPath, {
        cases: [
          {
            dates: [
              {
                date: "2025-02-03",
                type: "wound-up-on",
              },
            ],
            number: "1",
            type: "members-voluntary-liquidation",
          },
        ],
      }),
    ]);
    const filingClient = new QueueCompaniesHouseClient([
      responseFromText(filingPath, fixtureText("filing-history.json")),
    ]);

    await expect(
      fetchPersonsWithSignificantControl(pscClient, "SC123456"),
    ).resolves.toMatchObject({
      items: [
        {
          id: "/company/SC123456/persons-with-significant-control/individual/psc-001",
        },
        {
          id: "/company/SC123456/persons-with-significant-control/individual/psc-002",
        },
      ],
    });
    await expect(
      fetchCompanyCharges(chargesClient, "SC123456"),
    ).resolves.toMatchObject({
      items: [{ id: "SC1234560001" }, { id: "SC1234560002" }],
    });
    await expect(
      fetchCompanyInsolvency(insolvencyClient, "SC123456"),
    ).resolves.toMatchObject({
      cases: [
        {
          dates: [{ date: "2025-02-03", type: "wound-up-on" }],
          number: "1",
          type: "members-voluntary-liquidation",
        },
      ],
    });
    await expect(
      fetchCompanyFilingHistory(filingClient, "SC123456"),
    ).resolves.toMatchObject({
      items: [
        {
          documentMetadataPath: "/document/doc-cs-001",
          id: "MzAwMDAwMDAx",
        },
        {
          documentMetadataPath: "/document/doc-accounts-002",
          id: "MzAwMDAwMDAy",
        },
      ],
    });

    expect(pscClient.requests).toEqual([pscPath]);
    expect(chargesClient.requests).toEqual([chargesPath]);
    expect(insolvencyClient.requests).toEqual([insolvencyPath]);
    expect(filingClient.requests).toEqual([filingPath]);
  });

  it("propagates 404 and 403 errors instead of treating endpoints as available", async () => {
    const notFoundClient = new QueueCompaniesHouseClient([
      new ResourceNotFoundError("Companies House resource was not found.", {
        status: 404,
      }),
    ]);
    const forbiddenClient = new QueueCompaniesHouseClient([
      new CompaniesHouseHttpError(
        "Companies House request failed with HTTP 403.",
        {
          status: 403,
        },
      ),
    ]);

    await expect(
      fetchCompanyProfile(notFoundClient, "SC123456"),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(
      fetchCompanyOfficers(forbiddenClient, "SC123456"),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});
