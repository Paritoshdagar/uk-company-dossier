import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createEvidenceRef,
  normaliseCharges,
  normaliseCompanyProfile,
  normaliseFilingHistory,
  normaliseInsolvency,
  normaliseOfficers,
  normalisePersonsWithSignificantControl,
} from "../../src/companies-house/normalise.js";
import type { EvidenceRef } from "../../src/contracts/company-evidence.js";

const sourceUri =
  "https://api.company-information.service.gov.uk/company/SC123456";
const retrievedAt = "2026-02-03T04:05:06.789Z";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/companies-house/${name}`, import.meta.url),
      "utf8",
    ),
  ) as unknown;
}

function expectedHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidenceFor(
  bytes: Uint8Array = Buffer.from("{}", "utf8"),
): EvidenceRef {
  return createEvidenceRef({
    rawBytes: bytes,
    retrievedAt,
    sourceUri,
  });
}

describe("Companies House evidence references", () => {
  it("hashes exact raw response bytes instead of re-serialised objects", () => {
    const compactBytes = Buffer.from('{"company_number":"SC123456"}', "utf8");
    const spacedBytes = Buffer.from(
      '{\n  "company_number": "SC123456"\n}',
      "utf8",
    );

    expect(
      createEvidenceRef({
        rawBytes: compactBytes,
        retrievedAt,
        sourceUri,
      }),
    ).toEqual({
      payloadSha256: expectedHash(compactBytes),
      retrievedAt,
      sourceUri,
    });
    expect(expectedHash(compactBytes)).not.toBe(expectedHash(spacedBytes));
  });
});

describe("Companies House normalisation", () => {
  it("normalises company profile dates, registered-address components, and enumeration values", () => {
    const evidence = evidenceFor();
    const profile = normaliseCompanyProfile(fixture("profile.json"), evidence);

    expect(profile).toEqual({
      companyName: "ALPHA-BETA HOLDINGS LIMITED",
      companyNumber: "SC123456",
      companyStatus: "active",
      dateOfCreation: "2020-01-02",
      evidence,
      jurisdiction: "scotland",
      registeredOfficeAddress: {
        addressLine1: "Example Street",
        country: "Scotland",
        locality: "Edinburgh",
        postalCode: "EH1 1AA",
        premises: "1",
      },
      sicCodes: ["62012", "62020"],
      type: "ltd",
    });
  });

  it("normalises officers without personal addresses and sorts by stable appointment id", () => {
    const evidence = evidenceFor();
    const page = fixture("officers-page-1.json");
    const officers = normaliseOfficers(page, evidence);

    expect(officers.map((officer) => officer.id)).toEqual([
      "appt-001",
      "appt-002",
    ]);
    expect(officers).toEqual([
      {
        appointedOn: "2020-06-01",
        evidence,
        id: "appt-001",
        linksSelf: "/company/SC123456/appointments/appt-001",
        name: "JANE SYNTHETIC",
        officerRole: "secretary",
      },
      {
        appointedOn: "2021-01-01",
        countryOfResidence: "United Kingdom",
        evidence,
        id: "appt-002",
        linksSelf: "/company/SC123456/appointments/appt-002",
        name: "JOHN SYNTHETIC",
        officerRole: "director",
      },
    ]);
    expect(JSON.stringify(officers)).not.toMatch(/address/iu);
  });

  it("normalises PSC records with verbatim control enumerations sorted deterministically", () => {
    const evidence = evidenceFor();
    const pscs = normalisePersonsWithSignificantControl(
      fixture("psc.json"),
      evidence,
    );

    expect(pscs).toEqual([
      {
        evidence,
        id: "/company/SC123456/persons-with-significant-control/individual/psc-001",
        kind: "individual-person-with-significant-control",
        name: "FIRST SYNTHETIC",
        naturesOfControl: [
          "ownership-of-shares-25-to-50-percent",
          "right-to-appoint-and-remove-directors",
        ],
        notifiedOn: "2020-05-06",
      },
      {
        ceasedOn: "2025-01-31",
        evidence,
        id: "/company/SC123456/persons-with-significant-control/individual/psc-002",
        kind: "individual-person-with-significant-control",
        name: "SECOND SYNTHETIC",
        naturesOfControl: [
          "ownership-of-shares-75-to-100-percent",
          "voting-rights-75-to-100-percent",
        ],
        notifiedOn: "2021-02-03",
      },
    ]);
  });

  it("normalises charges and filing history with stable identifiers and document metadata paths", () => {
    const evidence = evidenceFor();

    expect(normaliseCharges(fixture("charges.json"), evidence)).toEqual([
      {
        classificationType: "charge-description",
        createdOn: "2020-03-04",
        deliveredOn: "2020-03-06",
        evidence,
        id: "SC1234560001",
        personsEntitled: ["EXAMPLE LENDER LIMITED"],
        status: "fully-satisfied",
      },
      {
        classificationType: "charge-description",
        createdOn: "2024-01-02",
        deliveredOn: "2024-01-05",
        evidence,
        id: "SC1234560002",
        personsEntitled: ["SYNTHETIC BANK PLC"],
        status: "outstanding",
      },
    ]);
    expect(
      normaliseFilingHistory(fixture("filing-history.json"), evidence),
    ).toEqual([
      {
        category: "confirmation-statement",
        date: "2024-05-01",
        description: "confirmation-statement-with-updates",
        documentMetadataPath: "/document/doc-cs-001",
        evidence,
        id: "MzAwMDAwMDAx",
        paperFiled: false,
        type: "CS01",
      },
      {
        category: "accounts",
        date: "2024-10-01",
        description: "accounts-with-accounts-type-total-exemption-full",
        documentMetadataPath: "/document/doc-accounts-002",
        evidence,
        id: "MzAwMDAwMDAy",
        paperFiled: false,
        type: "AA",
      },
    ]);
  });

  it("normalises insolvency cases while retaining documented case date values", () => {
    const evidence = evidenceFor();

    expect(
      normaliseInsolvency(
        {
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
        },
        evidence,
      ),
    ).toEqual({
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
      evidence,
    });
  });
});
