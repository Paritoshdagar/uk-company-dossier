import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaginatedCompaniesHouseResource } from "../../src/companies-house/endpoints.js";
import type {
  NormalisedCharge,
  NormalisedCompanyProfile,
  NormalisedFilingHistoryItem,
  NormalisedInsolvency,
  NormalisedOfficer,
  NormalisedPersonWithSignificantControl,
} from "../../src/companies-house/normalise.js";
import type { EvidenceRef } from "../../src/contracts/company-evidence.js";
import type {
  DossierEndpointGateway,
  DossierEndpointResult,
} from "../../src/app/dossier-service.js";

const originalEnvironment = process.env;
const companyNumber = "SC123456";
const generatedAt = "2026-06-21T12:00:00.000Z";
const retrievedAt = "2026-06-21T11:59:00.000Z";
const payloadSha256 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

afterEach(() => {
  process.env = originalEnvironment;
  vi.restoreAllMocks();
});

interface CapturedCliRun {
  readonly exitCode: number | undefined;
  readonly stderr: string;
  readonly stdout: string;
}

type CliDependencies = Parameters<
  typeof import("../../src/cli/main.js").createProgram
>[0];

function evidence(sourceUri: string): EvidenceRef {
  return {
    payloadSha256,
    retrievedAt,
    sourceUri,
  };
}

function unavailableEndpoint(): Promise<never> {
  return Promise.reject(new Error("fixture endpoint unavailable"));
}

function unavailableResult<TResource>(): Promise<
  DossierEndpointResult<TResource>
> {
  return unavailableEndpoint();
}

function paginatedResource<TItem>(
  items: readonly TItem[],
  resourceEvidence: readonly EvidenceRef[] = [
    evidence(
      "https://api.company-information.service.gov.uk/company/SC123456/filing-history",
    ),
  ],
): PaginatedCompaniesHouseResource<TItem> {
  return {
    companyNumber,
    evidence: resourceEvidence,
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
    documentMetadataPath: "/document/abc123",
    evidence: evidence(
      "https://api.company-information.service.gov.uk/company/SC123456/filing-history",
    ),
    id: "MzAwOTk5",
    paperFiled: false,
    type: "AA",
    ...overrides,
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

function fixtureGateway(
  filings: readonly NormalisedFilingHistoryItem[] = [
    filingItem(),
    filingItem({
      category: "confirmation-statement",
      date: "2025-05-01",
      description: "confirmation-statement",
      documentMetadataPath: "/document/def456",
      id: "MzAxMDAw",
      type: "CS01",
    }),
  ],
): DossierEndpointGateway {
  return {
    fetchCompanyCharges: () =>
      unavailableResult<PaginatedCompaniesHouseResource<NormalisedCharge>>(),
    fetchCompanyFilingHistory: () =>
      Promise.resolve(available(paginatedResource(filings))),
    fetchCompanyInsolvency: () => unavailableResult<NormalisedInsolvency>(),
    fetchCompanyOfficers: () =>
      unavailableResult<PaginatedCompaniesHouseResource<NormalisedOfficer>>(),
    fetchCompanyProfile: () => unavailableResult<NormalisedCompanyProfile>(),
    fetchPersonsWithSignificantControl: () =>
      unavailableResult<
        PaginatedCompaniesHouseResource<NormalisedPersonWithSignificantControl>
      >(),
  };
}

async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<CapturedCliRun> {
  const { createProgram } = await import("../../src/cli/main.js");
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  const program = createProgram({
    clock: {
      now: () => generatedAt,
    },
    gateway: fixtureGateway(),
    setExitCode: (code) => {
      exitCode = code;
    },
    writeErr: (text) => {
      stderr.push(text);
    },
    writeOut: (text) => {
      stdout.push(text);
    },
    ...dependencies,
  });

  program.configureOutput({
    writeErr: (text) => {
      stderr.push(text);
    },
    writeOut: (text) => {
      stdout.push(text);
    },
  });
  program.exitOverride();

  try {
    await program.parseAsync(["node", "dossier", ...args]);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "commander.helpDisplayed"
    ) {
      throw error;
    }
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

async function runProductionCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<CapturedCliRun> {
  const { runCli: runProduction } = await import("../../src/cli/main.js");
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`Unexpected process.exit(${String(code)})`);
  });

  try {
    await runProduction(["node", "dossier", ...args], {
      clock: {
        now: () => generatedAt,
      },
      gateway: fixtureGateway(),
      setExitCode: (code) => {
        exitCode = code;
      },
      writeErr: (text) => {
        stderr.push(text);
      },
      writeOut: (text) => {
        stdout.push(text);
      },
      ...dependencies,
    });
  } finally {
    exitSpy.mockRestore();
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dossier-cli-"));
}

describe("dossier CLI", () => {
  it("shows commands in help without reading or requiring an API key", async () => {
    process.env = new Proxy<NodeJS.ProcessEnv>(
      {},
      {
        get: (_target, property) => {
          if (
            typeof property === "string" &&
            /api.*key|key.*api/i.test(property)
          ) {
            throw new Error("CLI help attempted to read an API key");
          }

          return undefined;
        },
      },
    );

    const { createProgram } = await import("../../src/cli/main.js");
    const output: string[] = [];
    const program = createProgram();

    program.configureOutput({
      writeErr: (text) => {
        output.push(text);
      },
      writeOut: (text) => {
        output.push(text);
      },
    });
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "dossier", "--help"]),
    ).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });

    const help = output.join("");

    expect(help).toContain("dossier");
    expect(help).toContain("filings");
    expect(help).toContain("document");
    expect(help).toContain("doctor");
    expect(help).toContain("snapshot");
    expect(help).toContain("snapshot save");
    expect(help).toContain("snapshot list");
    expect(help).toContain("snapshot compare");
    expect(help).toContain("mcp");
    expect(help).not.toMatch(/api[ -]?key/i);
  });

  it("preserves production help as stdout with exit 0", async () => {
    const result = await runProductionCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("snapshot compare");
  });

  it.each([
    ["unknown root option", ["--bad-option"]],
    ["root option missing a value", [companyNumber, "--format"]],
    ["filings option missing a value", ["filings", companyNumber, "--from"]],
    ["unknown snapshot command", ["snapshot", "nonsense"]],
  ])("normalizes production parser errors for %s", async (_caseName, args) => {
    const result = await runProductionCli(args);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"error"');
    expect(result.stderr).toContain('"code": "invalid_input"');
    expect(result.stderr).not.toContain("stack");
  });

  it("runs doctor JSON output without exposing the configured API key", async () => {
    const secret = "do-not-print-from-cli-doctor";
    const { createProgram } = await import("../../src/cli/main.js");
    const output: string[] = [];
    let exitCode: number | undefined;
    const program = createProgram({
      loadEnvironment: () => ({
        COMPANIES_HOUSE_API_KEY: secret,
      }),
      setExitCode: (code) => {
        exitCode = code;
      },
      writeErr: (text) => {
        output.push(text);
      },
      writeOut: (text) => {
        output.push(text);
      },
    });

    await program.parseAsync(["node", "dossier", "doctor", "--json"]);

    const doctorOutput = output.join("");

    expect(exitCode).toBe(0);
    expect(doctorOutput).toContain('"readiness": "live-api-ready"');
    expect(doctorOutput).toContain('"configured": true');
    expect(doctorOutput).not.toContain(secret);
    expect(doctorOutput).not.toContain(String(secret.length));
  });

  it("writes a JSON dossier to stdout and exits 0 even when some sections are unavailable", async () => {
    const result = await runCli([companyNumber, "--format", "json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout) as {
      company: { companyNumber: string };
      sections: Record<string, { status: string }>;
    };

    expect(output.company.companyNumber).toBe(companyNumber);
    expect(output.sections.filings?.status).toBe("complete");
    expect(output.sections.profile?.status).toBe("unavailable");
  });

  it("reports a missing root company number as exit 2 without a report", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Company number is required");
  });

  it("reports a missing root company number as JSON when JSON mode is requested", async () => {
    const result = await runCli(["--format", "json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"error"');
    expect(result.stderr).toContain('"code": "invalid_input"');
    expect(result.stderr).toContain("Company number is required");
  });

  it("writes a Markdown dossier to a new output path without stdout noise", async () => {
    const directory = await tempDirectory();
    const outputPath = join(directory, "dossier.md");
    const result = await runCli([
      companyNumber,
      "--format",
      "markdown",
      "--output",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(readFile(outputPath, "utf8")).resolves.toContain(
      "# Company dossier:",
    );
  });

  it("creates missing parent directories for dossier output paths", async () => {
    const directory = await tempDirectory();
    const outputPath = join(directory, "nested", "reports", "dossier.json");
    const result = await runCli([
      companyNumber,
      "--format",
      "json",
      "--output",
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(readFile(outputPath, "utf8")).resolves.toContain(
      `"companyNumber": "${companyNumber}"`,
    );
  });

  it("refuses to overwrite an existing dossier output path with exit 2", async () => {
    const directory = await tempDirectory();
    const outputPath = join(directory, "dossier.json");
    await writeFile(outputPath, "existing", "utf8");

    const result = await runCli([
      companyNumber,
      "--format",
      "json",
      "--output",
      outputPath,
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"error"');
    expect(result.stderr).toContain('"code": "invalid_input"');
    await expect(readFile(outputPath, "utf8")).resolves.toBe("existing");
  });

  it.each(["", "   "])(
    "rejects blank dossier output path %j before service setup",
    async (outputPath) => {
      let serviceCalls = 0;
      const failIfCalled = () => {
        serviceCalls += 1;

        return Promise.reject(
          new Error("gateway should not be called for invalid output"),
        );
      };

      const result = await runCli(
        [companyNumber, "--format", "json", "--output", outputPath],
        {
          gateway: {
            fetchCompanyCharges: failIfCalled,
            fetchCompanyFilingHistory: failIfCalled,
            fetchCompanyInsolvency: failIfCalled,
            fetchCompanyOfficers: failIfCalled,
            fetchCompanyProfile: failIfCalled,
            fetchPersonsWithSignificantControl: failIfCalled,
          },
        },
      );

      expect(result.exitCode).toBe(2);
      expect(serviceCalls).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"code": "invalid_input"');
      expect(result.stderr).toContain("--output");
    },
  );

  it("validates company numbers before calling injected services", async () => {
    let serviceCalls = 0;
    const gateway = fixtureGateway();
    const result = await runCli(["bad-number", "--format", "json"], {
      gateway: {
        ...gateway,
        fetchCompanyFilingHistory: () => {
          serviceCalls += 1;

          return gateway.fetchCompanyFilingHistory(companyNumber);
        },
      },
    });

    expect(result.exitCode).toBe(2);
    expect(serviceCalls).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code": "invalid_input"');
  });

  it("reports invalid dossier formats as exit 2 without throwing", async () => {
    const result = await runCli([companyNumber, "--format", "xml"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code": "invalid_input"');
  });

  it("lists filings with category and date filters as JSON", async () => {
    const result = await runCli([
      "filings",
      companyNumber,
      "--category",
      "accounts",
      "--from",
      "2026-01-01",
      "--to",
      "2026-12-31",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout) as {
      companyNumber: string;
      items: readonly NormalisedFilingHistoryItem[];
    };

    expect(output.companyNumber).toBe(companyNumber);
    expect(output.items).toHaveLength(1);
    expect(output.items[0]?.category).toBe("accounts");
    expect(output.items[0]?.date).toBe("2026-01-15");
  });

  it("reports a missing filings company number as exit 2", async () => {
    const result = await runCli(["filings"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code": "invalid_input"');
    expect(result.stderr).toContain("Company number is required");
  });

  it("rejects invalid filing date filters with exit 2", async () => {
    const result = await runCli([
      "filings",
      companyNumber,
      "--from",
      "2026/01/01",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code": "invalid_input"');
  });

  it("retrieves a filing document through an injected service and reports metadata", async () => {
    const directory = await tempDirectory();
    let forceWasForwarded = false;
    const result = await runCli(
      ["document", "abc123", "--output-dir", directory],
      {
        retrieveDocument: async (options) => {
          forceWasForwarded = options.force === false;
          await mkdir(directory, { recursive: true });
          const filePath = join(directory, "abc123.pdf");
          await writeFile(filePath, "PDF", "utf8");

          return {
            bytes: Buffer.from("PDF"),
            contentType: "application/pdf",
            documentId: options.documentId ?? "missing",
            filePath,
            retrievedAt,
            sha256: payloadSha256,
            sourceUri:
              "https://document-api.company-information.service.gov.uk/document/abc123/content",
          };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(forceWasForwarded).toBe(true);

    const output = JSON.parse(result.stdout) as {
      contentType: string;
      documentId: string;
      filePath: string;
    };

    expect(output.documentId).toBe("abc123");
    expect(output.contentType).toBe("application/pdf");
    await expect(readFile(output.filePath, "utf8")).resolves.toBe("PDF");
  });

  it("maps unexpected document service failures to exit 1 with a stable JSON error", async () => {
    const result = await runCli(["document", "abc123"], {
      retrieveDocument: () => {
        throw new Error("boom with api_key=secret");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"error"');
    expect(result.stderr).toContain('"code": "internal_error"');
    expect(result.stderr).not.toContain("secret");
    expect(result.stderr).not.toContain("stack");
  });

  it("saves, lists, and compares dossier snapshots", async () => {
    const snapshotDir = await tempDirectory();
    const firstSave = await runCli(
      ["snapshot", "save", companyNumber, "--snapshot-dir", snapshotDir],
      {
        clock: {
          now: () => "2026-06-21T12:00:00.000Z",
        },
      },
    );
    const secondSave = await runCli(
      ["snapshot", "save", companyNumber, "--snapshot-dir", snapshotDir],
      {
        clock: {
          now: () => "2026-06-21T12:01:00.000Z",
        },
      },
    );

    expect(firstSave.exitCode).toBe(0);
    expect(secondSave.exitCode).toBe(0);

    const firstMetadata = JSON.parse(firstSave.stdout) as { path: string };
    const secondMetadata = JSON.parse(secondSave.stdout) as { path: string };
    const listResult = await runCli([
      "snapshot",
      "list",
      companyNumber,
      "--snapshot-dir",
      snapshotDir,
    ]);
    const compareResult = await runCli([
      "snapshot",
      "compare",
      firstMetadata.path,
      secondMetadata.path,
    ]);

    expect(listResult.exitCode).toBe(0);
    expect(compareResult.exitCode).toBe(0);

    const listed = JSON.parse(listResult.stdout) as readonly unknown[];
    const comparison = JSON.parse(compareResult.stdout) as {
      hasChanges: boolean;
    };

    expect(listed).toHaveLength(2);
    expect(comparison.hasChanges).toBe(true);
  });

  it("reports a missing snapshot directory as exit 2", async () => {
    const result = await runCli(["snapshot", "save", companyNumber]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code": "invalid_input"');
    expect(result.stderr).toContain("--snapshot-dir");
  });

  it("runs doctor JSON output without an API key in fixture-ready mode", async () => {
    const result = await runCli(["doctor", "--json"], {
      gateway: undefined,
      loadEnvironment: () => ({}),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"readiness": "fixture-ready"');
  });

  it("starts the MCP surface through injection without stdout noise", async () => {
    let started = false;
    const result = await runCli(["mcp"], {
      startMcp: () => {
        started = true;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(started).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("returns exit 3 when a required live service is unavailable", async () => {
    const result = await runCli(["mcp"], {
      startMcp: undefined,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("MCP service is not available");
  });
});
