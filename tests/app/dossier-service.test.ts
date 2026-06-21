import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { PaginatedCompaniesHouseResource } from "../../src/companies-house/endpoints.js";
import {
  createEvidenceRef,
  normaliseCharges,
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
} from "../../src/companies-house/normalise.js";
import {
  companyDossierSchema,
  type CompanyDossier,
  type EvidenceRef,
  type EvidenceSection,
  type Fact,
} from "../../src/contracts/company-evidence.js";
import {
  CompaniesHouseHttpError,
  RateLimitError,
} from "../../src/contracts/errors.js";
import {
  buildCompanyDossier,
  type DossierClock,
  type DossierEndpointGateway,
  type DossierEndpointResult,
} from "../../src/app/dossier-service.js";

const apiBaseUrl = "https://api.company-information.service.gov.uk";
const companyNumber = "SC123456";
const generatedAt = "2026-06-21T12:00:00.000Z";
const retrievedAt = "2026-06-21T11:59:00.000Z";

interface GatewayState {
  readonly fetchCompanyCharges: () => Promise<
    DossierEndpointResult<PaginatedCompaniesHouseResource<NormalisedCharge>>
  >;
  readonly fetchCompanyFilingHistory: () => Promise<
    DossierEndpointResult<
      PaginatedCompaniesHouseResource<NormalisedFilingHistoryItem>
    >
  >;
  readonly fetchCompanyInsolvency: () => Promise<
    DossierEndpointResult<NormalisedInsolvency>
  >;
  readonly fetchCompanyOfficers: () => Promise<
    DossierEndpointResult<PaginatedCompaniesHouseResource<NormalisedOfficer>>
  >;
  readonly fetchCompanyProfile: () => Promise<
    DossierEndpointResult<NormalisedCompanyProfile>
  >;
  readonly fetchPersonsWithSignificantControl: () => Promise<
    DossierEndpointResult<
      PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl>
    >
  >;
}

type GatewayOverrides = Partial<GatewayState>;

const clock: DossierClock = {
  now: () => generatedAt,
};

class RecordingGateway implements DossierEndpointGateway {
  readonly #state: GatewayState;
  public readonly calls: string[] = [];

  public constructor(overrides: GatewayOverrides = {}) {
    this.#state = {
      ...createGatewayState(),
      ...overrides,
    };
  }

  public fetchCompanyCharges(
    requestedCompanyNumber: string,
  ): Promise<
    DossierEndpointResult<PaginatedCompaniesHouseResource<NormalisedCharge>>
  > {
    this.calls.push(`charges:${requestedCompanyNumber}`);

    return this.#state.fetchCompanyCharges();
  }

  public fetchCompanyFilingHistory(
    requestedCompanyNumber: string,
  ): Promise<
    DossierEndpointResult<
      PaginatedCompaniesHouseResource<NormalisedFilingHistoryItem>
    >
  > {
    this.calls.push(`filings:${requestedCompanyNumber}`);

    return this.#state.fetchCompanyFilingHistory();
  }

  public fetchCompanyInsolvency(
    requestedCompanyNumber: string,
  ): Promise<DossierEndpointResult<NormalisedInsolvency>> {
    this.calls.push(`insolvency:${requestedCompanyNumber}`);

    return this.#state.fetchCompanyInsolvency();
  }

  public fetchCompanyOfficers(
    requestedCompanyNumber: string,
  ): Promise<
    DossierEndpointResult<PaginatedCompaniesHouseResource<NormalisedOfficer>>
  > {
    this.calls.push(`officers:${requestedCompanyNumber}`);

    return this.#state.fetchCompanyOfficers();
  }

  public fetchCompanyProfile(
    requestedCompanyNumber: string,
  ): Promise<DossierEndpointResult<NormalisedCompanyProfile>> {
    this.calls.push(`profile:${requestedCompanyNumber}`);

    return this.#state.fetchCompanyProfile();
  }

  public fetchPersonsWithSignificantControl(
    requestedCompanyNumber: string,
  ): Promise<
    DossierEndpointResult<
      PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl>
    >
  > {
    this.calls.push(`pscs:${requestedCompanyNumber}`);

    return this.#state.fetchPersonsWithSignificantControl();
  }
}

function fixtureText(name: string): string {
  return readFileSync(
    new URL(`../fixtures/companies-house/${name}`, import.meta.url),
    "utf8",
  );
}

function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name)) as unknown;
}

function evidenceFor(path: string, fixtureName: string): EvidenceRef {
  const rawBytes = Buffer.from(fixtureText(fixtureName), "utf8");

  return createEvidenceRef({
    rawBytes,
    retrievedAt,
    sourceUri: `${apiBaseUrl}${path}`,
  });
}

function evidenceForData(path: string, data: unknown): EvidenceRef {
  return createEvidenceRef({
    rawBytes: Buffer.from(JSON.stringify(data), "utf8"),
    retrievedAt,
    sourceUri: `${apiBaseUrl}${path}`,
  });
}

function available<TResource>(
  resource: TResource,
): DossierEndpointResult<TResource> {
  return {
    kind: "available",
    resource,
  };
}

function partial<TResource>(
  resource: TResource,
  warnings: readonly string[],
): DossierEndpointResult<TResource> {
  return {
    kind: "partial",
    resource,
    warnings,
  };
}

function notApplicable<TResource>(
  reason: string,
  evidence: readonly EvidenceRef[],
  ruleId: string,
): DossierEndpointResult<TResource> {
  return {
    evidence,
    kind: "not_applicable",
    reason,
    ruleId,
  };
}

function paginatedResource<TItem>(
  items: readonly TItem[],
  evidence: readonly EvidenceRef[],
  warnings: readonly string[] = [],
): PaginatedCompaniesHouseResource<TItem> {
  return {
    companyNumber,
    evidence,
    items,
    warnings,
  };
}

function createProfileResource(): NormalisedCompanyProfile {
  return normaliseCompanyProfile(
    fixtureJson("profile.json"),
    evidenceFor("/company/SC123456", "profile.json"),
  );
}

function createOfficersResource(): PaginatedCompaniesHouseResource<NormalisedOfficer> {
  const page1Evidence = evidenceFor(
    "/company/SC123456/officers?items_per_page=2&start_index=0",
    "officers-page-1.json",
  );
  const page2Evidence = evidenceFor(
    "/company/SC123456/officers?items_per_page=2&start_index=2",
    "officers-page-2.json",
  );

  return paginatedResource(
    [
      ...normaliseOfficers(fixtureJson("officers-page-1.json"), page1Evidence),
      ...normaliseOfficers(fixtureJson("officers-page-2.json"), page2Evidence),
    ],
    [page1Evidence, page2Evidence],
  );
}

function createPartialOfficersResource(): PaginatedCompaniesHouseResource<NormalisedOfficer> {
  const page1Evidence = evidenceFor(
    "/company/SC123456/officers?items_per_page=2&start_index=0",
    "officers-page-1.json",
  );

  return paginatedResource(
    normaliseOfficers(fixtureJson("officers-page-1.json"), page1Evidence),
    [page1Evidence],
  );
}

function createPscResource(): PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl> {
  const pscEvidence = evidenceFor(
    "/company/SC123456/persons-with-significant-control?items_per_page=25&start_index=0",
    "psc.json",
  );

  return paginatedResource(
    normalisePersonsWithSignificantControl(
      fixtureJson("psc.json"),
      pscEvidence,
    ),
    [pscEvidence],
  );
}

function createChargesResource(): PaginatedCompaniesHouseResource<NormalisedCharge> {
  const chargesEvidence = evidenceFor(
    "/company/SC123456/charges?items_per_page=25&start_index=0",
    "charges.json",
  );

  return paginatedResource(
    normaliseCharges(fixtureJson("charges.json"), chargesEvidence),
    [chargesEvidence],
  );
}

function createEmptyChargesResource(): PaginatedCompaniesHouseResource<NormalisedCharge> {
  const emptyChargesPage = {
    items: [],
    items_per_page: 25,
    start_index: 0,
    total_results: 0,
  };
  const chargesEvidence = evidenceForData(
    "/company/SC123456/charges?items_per_page=25&start_index=0",
    emptyChargesPage,
  );

  return paginatedResource([], [chargesEvidence]);
}

function createInsolvencyResource(): NormalisedInsolvency {
  return normaliseInsolvency(
    {
      cases: [
        {
          dates: [{ date: "2025-02-03", type: "wound-up-on" }],
          number: "1",
          type: "members-voluntary-liquidation",
        },
      ],
    },
    evidenceForData("/company/SC123456/insolvency", {
      cases: [
        {
          dates: [{ date: "2025-02-03", type: "wound-up-on" }],
          number: "1",
          type: "members-voluntary-liquidation",
        },
      ],
    }),
  );
}

function createEmptyInsolvencyResource(): NormalisedInsolvency {
  return normaliseInsolvency(
    fixtureJson("insolvency-none.json"),
    evidenceFor("/company/SC123456/insolvency", "insolvency-none.json"),
  );
}

function createFilingsResource(): PaginatedCompaniesHouseResource<NormalisedFilingHistoryItem> {
  const filingsEvidence = evidenceFor(
    "/company/SC123456/filing-history?items_per_page=25&start_index=0",
    "filing-history.json",
  );

  return paginatedResource(
    normaliseFilingHistory(fixtureJson("filing-history.json"), filingsEvidence),
    [filingsEvidence],
  );
}

function createGatewayState(): GatewayState {
  return {
    fetchCompanyCharges: () =>
      Promise.resolve(available(createChargesResource())),
    fetchCompanyFilingHistory: () =>
      Promise.resolve(available(createFilingsResource())),
    fetchCompanyInsolvency: () =>
      Promise.resolve(available(createInsolvencyResource())),
    fetchCompanyOfficers: () =>
      Promise.resolve(available(createOfficersResource())),
    fetchCompanyProfile: () =>
      Promise.resolve(available(createProfileResource())),
    fetchPersonsWithSignificantControl: () =>
      Promise.resolve(available(createPscResource())),
  };
}

async function buildParsedDossier(
  gateway: DossierEndpointGateway,
): Promise<CompanyDossier> {
  const dossier = await buildCompanyDossier({
    clock,
    companyNumber: " sc123456 ",
    gateway,
  });

  return companyDossierSchema.parse(dossier);
}

function dossierSection(
  dossier: CompanyDossier,
  sectionKey: string,
): EvidenceSection {
  const section = dossier.sections[sectionKey];

  if (section === undefined) {
    throw new Error(`Expected ${sectionKey} section.`);
  }

  return section;
}

function factById(section: EvidenceSection, id: string): Fact | undefined {
  return section.facts.find((fact) => fact.id === id);
}

function expectEveryFactHasEvidence(section: EvidenceSection): void {
  expect(section.facts.length).toBeGreaterThan(0);

  for (const fact of section.facts) {
    expect(
      fact.evidence.length,
      `${fact.id} should carry evidence`,
    ).toBeGreaterThan(0);
  }
}

interface SectionOutcomeCase {
  readonly createGateway: () => RecordingGateway;
  readonly name: string;
  readonly sectionKey: string;
  readonly verify: (section: EvidenceSection) => void;
}

const pscExemptionsEvidence = evidenceFor(
  "/company/SC123456/exemptions",
  "psc-exemptions.json",
);

const sectionOutcomeCases: readonly SectionOutcomeCase[] = [
  {
    createGateway: () => new RecordingGateway(),
    name: "resource fetched and facts produced becomes complete",
    sectionKey: "profile",
    verify: (section) => {
      expect(section.status).toBe("complete");
      expect(section.errors).toEqual([]);
      expect(factById(section, "profile.registered_name")?.value).toBe(
        "ALPHA-BETA HOLDINGS LIMITED",
      );
      expectEveryFactHasEvidence(section);
    },
  },
  {
    createGateway: () =>
      new RecordingGateway({
        fetchCompanyOfficers: () =>
          Promise.resolve(
            partial(createPartialOfficersResource(), [
              "Missing officers page /company/SC123456/officers?items_per_page=2&start_index=2 after an earlier successful page.",
            ]),
          ),
      }),
    name: "later page failure after earlier success becomes partial",
    sectionKey: "officers",
    verify: (section) => {
      expect(section.status).toBe("partial");
      expect(section.warnings).toEqual([
        expect.stringContaining("officers") as string,
      ]);
      expect(section.warnings.join("\n")).toContain("start_index=2");
      expectEveryFactHasEvidence(section);
    },
  },
  {
    createGateway: () =>
      new RecordingGateway({
        fetchCompanyCharges: () =>
          Promise.reject(
            new CompaniesHouseHttpError(
              "Companies House request failed with HTTP 403.",
              {
                cause: {
                  code: "permission_denied",
                  message: "Forbidden",
                  status: 403,
                },
                status: 403,
              },
            ),
          ),
      }),
    name: "permission failure becomes unavailable with typed safe error",
    sectionKey: "charges",
    verify: (section) => {
      expect(section.status).toBe("unavailable");
      expect(section.facts).toEqual([]);
      expect(section.errors).toHaveLength(1);
      expect(section.errors[0]).toContain("companies_house_http_error");
      expect(section.errors[0]).toContain("403");
      expect(section.errors[0]).toContain("CompaniesHouseHttpError");
    },
  },
  {
    createGateway: () =>
      new RecordingGateway({
        fetchPersonsWithSignificantControl: () =>
          Promise.resolve(
            notApplicable(
              "Companies House exemptions endpoint records PSC disclosure exemption for this company.",
              [pscExemptionsEvidence],
              "dossier.section.pscs.v1",
            ),
          ),
      }),
    name: "documented endpoint non-applicability becomes not_applicable",
    sectionKey: "pscs",
    verify: (section) => {
      expect(section.status).toBe("not_applicable");
      expect(section.facts).toEqual([]);
      expect(section.errors).toEqual([]);
      expect(section.warnings).toEqual([
        expect.stringContaining("dossier.section.pscs.v1") as string,
      ]);
      expect(section.warnings.join("\n")).toContain(
        pscExemptionsEvidence.sourceUri,
      );
    },
  },
  {
    createGateway: () =>
      new RecordingGateway({
        fetchCompanyInsolvency: () =>
          Promise.resolve(available(createEmptyInsolvencyResource())),
      }),
    name: "legitimate empty list becomes complete with zero-result fact",
    sectionKey: "insolvency",
    verify: (section) => {
      expect(section.status).toBe("complete");
      expect(section.errors).toEqual([]);
      expect(factById(section, "insolvency.case_count")?.value).toBe(0);
      expectEveryFactHasEvidence(section);
    },
  },
];

describe("buildCompanyDossier", () => {
  it.each(sectionOutcomeCases)(
    "$name",
    async ({ createGateway, sectionKey, verify }) => {
      const dossier = await buildParsedDossier(createGateway());
      const section = dossierSection(dossier, sectionKey);

      expect(dossier).toMatchObject({
        company: {
          companyNumber,
        },
        generatedAt,
        schemaVersion: "1.0.0",
      });
      verify(section);
    },
  );

  it("attempts independent sections when the profile endpoint fails", async () => {
    const gateway = new RecordingGateway({
      fetchCompanyProfile: () =>
        Promise.reject(
          new RateLimitError("Companies House retry budget exhausted.", {
            cause: {
              code: "retry_exhausted",
              message: "Maximum retry attempts reached.",
            },
            retryAfterSeconds: 60,
          }),
        ),
    });

    const dossier = await buildParsedDossier(gateway);

    expect([...gateway.calls].sort()).toEqual(
      [
        "charges:SC123456",
        "filings:SC123456",
        "insolvency:SC123456",
        "officers:SC123456",
        "profile:SC123456",
        "pscs:SC123456",
      ].sort(),
    );
    expect(dossier.company).toEqual({ companyNumber });
    expect(dossierSection(dossier, "profile")).toMatchObject({
      errors: [expect.stringContaining("rate_limit_error") as string],
      facts: [],
      status: "unavailable",
    });
    expect(dossierSection(dossier, "officers").status).toBe("complete");
  });

  it("derives no-active-charges only when the charges input is complete", async () => {
    const completeDossier = await buildParsedDossier(
      new RecordingGateway({
        fetchCompanyCharges: () =>
          Promise.resolve(available(createEmptyChargesResource())),
      }),
    );
    const unavailableDossier = await buildParsedDossier(
      new RecordingGateway({
        fetchCompanyCharges: () =>
          Promise.reject(
            new CompaniesHouseHttpError(
              "Companies House charges response was malformed.",
              {
                cause: {
                  code: "malformed_response",
                  message: "items was not an array",
                },
              },
            ),
          ),
      }),
    );
    const partialDossier = await buildParsedDossier(
      new RecordingGateway({
        fetchCompanyCharges: () =>
          Promise.resolve(
            partial(createEmptyChargesResource(), [
              "Missing charges page /company/SC123456/charges?items_per_page=25&start_index=25 after an earlier successful page.",
            ]),
          ),
      }),
    );

    expect(
      factById(dossierSection(completeDossier, "charges"), "charges.no_active"),
    ).toMatchObject({
      origin: "derived",
      ruleId: "dossier.section.charges.v1",
      value: true,
    });
    expect(
      factById(
        dossierSection(unavailableDossier, "charges"),
        "charges.no_active",
      ),
    ).toBeUndefined();
    expect(
      factById(dossierSection(partialDossier, "charges"), "charges.no_active"),
    ).toBeUndefined();
  });
});
