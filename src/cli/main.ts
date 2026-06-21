#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import {
  buildCompanyDossier,
  type DossierClock,
  type DossierEndpointGateway,
  type DossierEndpointOutcome,
  type DossierEndpointResult,
} from "../app/dossier-service.js";
import { createCompaniesHouseClient } from "../companies-house/client.js";
import type { CompaniesHouseClient } from "../companies-house/client.js";
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
import { type NormalisedFilingHistoryItem } from "../companies-house/normalise.js";
import {
  loadEnvironmentFromProcess,
  parseEnvironment,
  type EnvironmentInput,
  type ParsedEnvironment,
} from "../config/environment.js";
import {
  ConfigurationError,
  DocumentSafetyError,
  DossierError,
  redactSecretText,
  SnapshotError,
} from "../contracts/errors.js";
import {
  formatDoctorResult,
  runDoctorChecks,
  type DoctorCheckDependencies,
  type DoctorResult,
} from "../doctor/checks.js";
import { renderCompanyDossierJson } from "../renderers/json-renderer.js";
import { renderCompanyDossierMarkdown } from "../renderers/markdown-renderer.js";
import { stableJsonStringify } from "../renderers/json-renderer.js";
import {
  compareDossierSnapshots,
  listDossierSnapshots,
  saveDossierSnapshot,
} from "../snapshots/store.js";

export interface CliDependencies {
  readonly clock?: DossierClock;
  readonly doctorChecks?: DoctorCheckDependencies;
  readonly gateway?: DossierEndpointGateway;
  readonly loadEnvironment?: () => EnvironmentInput | Promise<EnvironmentInput>;
  readonly retrieveDocument?: (
    options: RetrieveFilingDocumentOptions,
  ) => Promise<RetrievedFilingDocument>;
  readonly setExitCode?: (code: number) => void;
  readonly startMcp?: () => Promise<void> | void;
  readonly writeErr?: (text: string) => void;
  readonly writeOut?: (text: string) => void;
}

interface DoctorCommandOptions {
  readonly json?: boolean;
  readonly live?: boolean;
}

interface DossierCommandOptions {
  readonly format?: string;
  readonly output?: string;
}

interface FilingsCommandOptions {
  readonly category?: string;
  readonly from?: string;
  readonly to?: string;
}

interface DocumentCommandOptions {
  readonly force?: boolean;
  readonly outputDir?: string;
}

interface SnapshotDirectoryOptions {
  readonly snapshotDir?: string;
}

type CliErrorCode =
  | "configuration_error"
  | "internal_error"
  | "invalid_input"
  | "service_unavailable";

type CliExitCode = 1 | 2 | 3;

const defaultCliDependencies = {
  clock: {
    now: () => new Date(),
  },
  loadEnvironment: loadEnvironmentFromProcess,
  retrieveDocument: retrieveFilingDocument,
  setExitCode: (code: number) => {
    process.exitCode = code;
  },
  startMcp: async () => {
    const { startDossierMcpServer } = await import("../mcp/server.js");

    await startDossierMcpServer();
  },
  writeErr: (text: string) => {
    process.stderr.write(text);
  },
  writeOut: (text: string) => {
    process.stdout.write(text);
  },
} satisfies Required<Omit<CliDependencies, "doctorChecks" | "gateway">>;

function createRuntime(
  dependencies: CliDependencies = {},
): RuntimeDependencies {
  return {
    ...defaultCliDependencies,
    ...dependencies,
    retrieveDocumentIsInjected: dependencies.retrieveDocument !== undefined,
  };
}

class CliCommandError extends Error {
  public readonly code: CliErrorCode;
  public readonly exitCode: CliExitCode;

  public constructor(
    code: CliErrorCode,
    message: string,
    exitCode: CliExitCode,
  ) {
    super(redactSecretText(message));
    this.name = "CliCommandError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecretText(error.message);
  }

  return redactSecretText(String(error));
}

function createConfigurationErrorResult(
  requestedMode: DoctorResult["requestedMode"],
  error: unknown,
): DoctorResult {
  return {
    canRunRequestedMode: false,
    checks: [
      {
        id: "configuration",
        message: safeErrorMessage(error),
        status: "fail",
      },
    ],
    readiness: "fixture-ready",
    requestedMode,
  };
}

function writeJson(runtime: RuntimeDependencies, value: unknown): void {
  runtime.writeOut(`${stableJsonStringify(value)}\n`);
}

function writeError(
  runtime: RuntimeDependencies,
  error: unknown,
  options: { readonly json: boolean },
): void {
  const normalized = normalizeCliError(error);
  const message = redactSecretText(normalized.message);

  if (options.json) {
    runtime.writeErr(
      `${stableJsonStringify({
        error: {
          code: normalized.code,
          message,
        },
      })}\n`,
    );
  } else {
    runtime.writeErr(`Error [${normalized.code}]: ${message}\n`);
  }

  runtime.setExitCode(normalized.exitCode);
}

function configureManagedParserOutput(
  command: Command,
  runtime: RuntimeDependencies,
): void {
  command.configureOutput({
    writeErr: () => {
      // Commander includes stack-free parser text in the thrown error. Suppress
      // its direct stderr writes so runCli can emit one stable error envelope.
    },
    writeOut: runtime.writeOut,
  });
  command.exitOverride();

  for (const childCommand of command.commands) {
    configureManagedParserOutput(childCommand, runtime);
  }
}

function isCommanderDisplayExit(error: CommanderError): boolean {
  return (
    error.exitCode === 0 &&
    (error.code === "commander.helpDisplayed" ||
      error.code === "commander.version")
  );
}

function commanderParserError(error: CommanderError): CliCommandError {
  const message =
    error.message.trim().length === 0 ? "Invalid CLI input." : error.message;

  return new CliCommandError("invalid_input", message, 2);
}

function normalizeCliError(error: unknown): CliCommandError {
  if (error instanceof CliCommandError) {
    return error;
  }

  if (error instanceof ConfigurationError) {
    return new CliCommandError("configuration_error", error.message, 2);
  }

  if (error instanceof DocumentSafetyError || error instanceof SnapshotError) {
    return new CliCommandError("invalid_input", error.message, 2);
  }

  if (error instanceof DossierError) {
    return new CliCommandError("service_unavailable", error.message, 3);
  }

  return new CliCommandError("internal_error", safeErrorMessage(error), 1);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const companyNumberPattern = /^[0-9A-Z]{8}$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const documentIdPattern = /^[A-Za-z0-9_-]+$/u;

function parseCompanyNumberInput(companyNumber: string | undefined): string {
  if (companyNumber === undefined || companyNumber.trim().length === 0) {
    throw new CliCommandError(
      "invalid_input",
      "Company number is required.",
      2,
    );
  }

  const normalized = companyNumber.trim().toUpperCase();

  if (!companyNumberPattern.test(normalized)) {
    throw new CliCommandError(
      "invalid_input",
      "Company number must be exactly 8 alphanumeric characters.",
      2,
    );
  }

  return normalized;
}

function parseRequiredPath(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CliCommandError(
      "invalid_input",
      `${label} must be a non-empty path.`,
      2,
    );
  }

  return value;
}

function parseDocumentId(documentId: string | undefined): string {
  if (documentId === undefined || documentId.trim().length === 0) {
    throw new CliCommandError("invalid_input", "Document ID is required.", 2);
  }

  const trimmed = documentId.trim();

  if (!documentIdPattern.test(trimmed)) {
    throw new CliCommandError(
      "invalid_input",
      "Document ID must be a non-empty identifier without path separators.",
      2,
    );
  }

  return trimmed;
}

function parseIsoDate(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !isoDatePattern.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  ) {
    throw new CliCommandError(
      "invalid_input",
      `${label} must use YYYY-MM-DD format.`,
      2,
    );
  }

  return value;
}

function parseFilingsFilters(options: FilingsCommandOptions): {
  readonly category?: string;
  readonly from?: string;
  readonly to?: string;
} {
  const category =
    options.category === undefined || options.category.trim().length === 0
      ? undefined
      : options.category.trim();
  const from = parseIsoDate(options.from, "--from");
  const to = parseIsoDate(options.to, "--to");

  if (from !== undefined && to !== undefined && from > to) {
    throw new CliCommandError(
      "invalid_input",
      "--from must be earlier than or equal to --to.",
      2,
    );
  }

  const filters: {
    category?: string;
    from?: string;
    to?: string;
  } = {};

  if (category !== undefined) {
    filters.category = category;
  }

  if (from !== undefined) {
    filters.from = from;
  }

  if (to !== undefined) {
    filters.to = to;
  }

  return filters;
}

function outputFormat(options: DossierCommandOptions): "json" | "markdown" {
  const format = options.format ?? "json";

  if (format !== "json" && format !== "markdown") {
    throw new CliCommandError(
      "invalid_input",
      "--format must be either json or markdown.",
      2,
    );
  }

  return format;
}

function dossierErrorUsesJson(options: DossierCommandOptions): boolean {
  return options.format !== "markdown";
}

async function assertOutputPathAvailable(outputPath: string): Promise<void> {
  try {
    await access(outputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw new CliCommandError(
      "invalid_input",
      `Unable to inspect output path: ${safeErrorMessage(error)}`,
      2,
    );
  }

  throw new CliCommandError(
    "invalid_input",
    "Output file already exists. Choose a new path.",
    2,
  );
}

async function writeOutputFile(
  outputPath: string,
  content: string,
): Promise<void> {
  try {
    await writeFile(outputPath, content, { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CliCommandError(
        "invalid_input",
        "Output file already exists. Choose a new path.",
        2,
      );
    }

    throw error;
  }
}

async function loadParsedEnvironment(
  runtime: RuntimeDependencies,
): Promise<ParsedEnvironment> {
  return parseEnvironment(await runtime.loadEnvironment());
}

async function createLiveClient(runtime: RuntimeDependencies): Promise<{
  readonly client: CompaniesHouseClient;
  readonly environment: ParsedEnvironment;
}> {
  const environment = await loadParsedEnvironment(runtime);

  if (!environment.apiKeyConfigured) {
    throw new CliCommandError(
      "service_unavailable",
      "Companies House API key is required for live Companies House commands.",
      3,
    );
  }

  return {
    client: createCompaniesHouseClient({
      apiBaseUrl: environment.apiBaseUrl,
      getApiKey: () => environment.getApiKey(),
    }),
    environment,
  };
}

async function createGateway(
  runtime: RuntimeDependencies,
): Promise<DossierEndpointGateway> {
  if (runtime.gateway !== undefined) {
    return runtime.gateway;
  }

  const { client } = await createLiveClient(runtime);

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
  readonly evidence: readonly unknown[];
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
  filters: ReturnType<typeof parseFilingsFilters>,
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

function snapshotLocation(
  input: string | undefined,
  label: string,
): {
  readonly fileName: string;
  readonly snapshotDir: string;
} {
  const absolutePath = resolve(parseRequiredPath(input, label));

  return {
    fileName: basename(absolutePath),
    snapshotDir: dirname(absolutePath),
  };
}

async function runDossierCommand(
  runtime: RuntimeDependencies,
  companyNumberInput: string | undefined,
  options: DossierCommandOptions,
): Promise<void> {
  const companyNumber = parseCompanyNumberInput(companyNumberInput);
  const format = outputFormat(options);
  const outputPath =
    options.output === undefined
      ? undefined
      : parseRequiredPath(options.output, "--output");

  if (outputPath !== undefined) {
    await assertOutputPathAvailable(outputPath);
  }

  const dossier = await buildCompanyDossier({
    clock: runtime.clock,
    companyNumber,
    gateway: await createGateway(runtime),
  });
  const rendered =
    format === "json"
      ? renderCompanyDossierJson(dossier)
      : renderCompanyDossierMarkdown(dossier);

  if (outputPath === undefined) {
    runtime.writeOut(rendered);
  } else {
    await writeOutputFile(outputPath, rendered);
  }

  runtime.setExitCode(0);
}

async function runFilingsCommand(
  runtime: RuntimeDependencies,
  companyNumberInput: string | undefined,
  options: FilingsCommandOptions,
): Promise<void> {
  const companyNumber = parseCompanyNumberInput(companyNumberInput);
  const filters = parseFilingsFilters(options);
  const gateway = await createGateway(runtime);
  const result = unwrapFilings(
    await gateway.fetchCompanyFilingHistory(companyNumber),
    companyNumber,
  );

  writeJson(runtime, {
    companyNumber,
    evidence: result.evidence,
    filters,
    items: filterFilings(result.items, filters),
    warnings: result.warnings,
  });
  runtime.setExitCode(0);
}

async function runDocumentCommand(
  runtime: RuntimeDependencies,
  documentIdInput: string | undefined,
  options: DocumentCommandOptions,
): Promise<void> {
  const documentId = parseDocumentId(documentIdInput);
  const outputDirectory =
    options.outputDir === undefined
      ? undefined
      : parseRequiredPath(options.outputDir, "--output-dir");
  const liveServices = runtime.retrieveDocumentIsInjected
    ? undefined
    : await createLiveClient(runtime);
  const request: {
    client: CompaniesHouseClient;
    documentApiBaseUrl?: string;
    documentId: string;
    force: boolean;
    outputDirectory?: string;
  } = {
    client: liveServices?.client ?? unavailableDocumentClient,
    documentId,
    force: options.force === true,
  };

  if (liveServices?.environment.documentApiBaseUrl !== undefined) {
    request.documentApiBaseUrl = liveServices.environment.documentApiBaseUrl;
  }

  if (outputDirectory !== undefined) {
    request.outputDirectory = outputDirectory;
  }

  const result = await runtime.retrieveDocument(request);
  const metadata = {
    contentType: result.contentType,
    documentId: result.documentId,
    filePath: result.filePath,
    retrievedAt: result.retrievedAt,
    sha256: result.sha256,
    sourceUri: result.sourceUri,
  };

  writeJson(runtime, metadata);
  runtime.setExitCode(0);
}

async function runSnapshotSaveCommand(
  runtime: RuntimeDependencies,
  companyNumberInput: string | undefined,
  options: SnapshotDirectoryOptions,
): Promise<void> {
  const companyNumber = parseCompanyNumberInput(companyNumberInput);
  const snapshotDir = parseRequiredPath(options.snapshotDir, "--snapshot-dir");
  const dossier = await buildCompanyDossier({
    clock: runtime.clock,
    companyNumber,
    gateway: await createGateway(runtime),
  });

  writeJson(
    runtime,
    await saveDossierSnapshot({
      dossier,
      snapshotDir,
    }),
  );
  runtime.setExitCode(0);
}

async function runSnapshotListCommand(
  runtime: RuntimeDependencies,
  companyNumberInput: string | undefined,
  options: SnapshotDirectoryOptions,
): Promise<void> {
  const companyNumber = parseCompanyNumberInput(companyNumberInput);
  const snapshotDir = parseRequiredPath(options.snapshotDir, "--snapshot-dir");

  writeJson(
    runtime,
    await listDossierSnapshots({
      companyNumber,
      snapshotDir,
    }),
  );
  runtime.setExitCode(0);
}

async function runSnapshotCompareCommand(
  runtime: RuntimeDependencies,
  beforeInput: string | undefined,
  afterInput: string | undefined,
): Promise<void> {
  const before = snapshotLocation(beforeInput, "before snapshot");
  const after = snapshotLocation(afterInput, "after snapshot");

  if (before.snapshotDir !== after.snapshotDir) {
    throw new CliCommandError(
      "invalid_input",
      "Snapshot compare requires both files to be in the same snapshot directory.",
      2,
    );
  }

  writeJson(
    runtime,
    await compareDossierSnapshots({
      afterFileName: after.fileName,
      beforeFileName: before.fileName,
      snapshotDir: before.snapshotDir,
    }),
  );
  runtime.setExitCode(0);
}

async function runMcpCommand(runtime: RuntimeDependencies): Promise<void> {
  if (runtime.startMcp === undefined) {
    throw new CliCommandError(
      "service_unavailable",
      "MCP service is not available in this build yet.",
      3,
    );
  }

  await runtime.startMcp();
  runtime.setExitCode(0);
}

interface RuntimeDependencies {
  readonly clock: DossierClock;
  readonly doctorChecks?: DoctorCheckDependencies;
  readonly gateway?: DossierEndpointGateway;
  readonly loadEnvironment: () => EnvironmentInput | Promise<EnvironmentInput>;
  readonly retrieveDocument: (
    options: RetrieveFilingDocumentOptions,
  ) => Promise<RetrievedFilingDocument>;
  readonly retrieveDocumentIsInjected: boolean;
  readonly setExitCode: (code: number) => void;
  readonly startMcp?: () => Promise<void> | void;
  readonly writeErr: (text: string) => void;
  readonly writeOut: (text: string) => void;
}

const unavailableDocumentClient: CompaniesHouseClient = {
  requestBytes: () =>
    Promise.reject(
      new CliCommandError(
        "service_unavailable",
        "Companies House API key is required for live Companies House commands.",
        3,
      ),
    ),
  requestJson: () =>
    Promise.reject(
      new CliCommandError(
        "service_unavailable",
        "Companies House API key is required for live Companies House commands.",
        3,
      ),
    ),
};

export function createProgram(dependencies: CliDependencies = {}): Command {
  const runtime = createRuntime(dependencies);
  const program = new Command();

  program
    .name("dossier")
    .description("Build reproducible UK company dossiers.")
    .version("0.1.0")
    .addHelpText(
      "after",
      [
        "",
        "Snapshot command forms:",
        "  snapshot save <companyNumber> --snapshot-dir <path>",
        "  snapshot list <companyNumber> --snapshot-dir <path>",
        "  snapshot compare <before> <after>",
      ].join("\n"),
    );

  program
    .argument("[companyNumber]", "Companies House company number.")
    .option("--format <format>", "Output format: json or markdown.", "json")
    .option("--output <path>", "Write dossier output to a new file.")
    .action(
      async (
        companyNumber: string | undefined,
        options: DossierCommandOptions,
      ) => {
        try {
          await runDossierCommand(runtime, companyNumber, options);
        } catch (error) {
          writeError(runtime, error, {
            json: dossierErrorUsesJson(options),
          });
        }
      },
    );

  program
    .command("filings")
    .description("List and filter company filing history.")
    .argument("[companyNumber]", "Companies House company number.")
    .option("--category <category>", "Filter by Companies House category.")
    .option("--from <date>", "Include filings on or after YYYY-MM-DD.")
    .option("--to <date>", "Include filings on or before YYYY-MM-DD.")
    .action(async (companyNumber: string, options: FilingsCommandOptions) => {
      try {
        await runFilingsCommand(runtime, companyNumber, options);
      } catch (error) {
        writeError(runtime, error, { json: true });
      }
    });

  program
    .command("document")
    .description(
      "Retrieve filing document metadata and optionally write the file.",
    )
    .argument("[documentId]", "Companies House document identifier.")
    .option(
      "--output-dir <path>",
      "Directory where the document file is written.",
    )
    .option("--force", "Overwrite an existing document file.")
    .action(async (documentId: string, options: DocumentCommandOptions) => {
      try {
        await runDocumentCommand(runtime, documentId, options);
      } catch (error) {
        writeError(runtime, error, { json: true });
      }
    });

  program
    .command("doctor")
    .description("Check local dossier prerequisites.")
    .option("--json", "Write machine-readable JSON output.")
    .option("--live", "Validate live Companies House API access.")
    .action(async (options: DoctorCommandOptions) => {
      const requestedMode = options.live === true ? "live" : "default";
      let result: DoctorResult;

      try {
        result = await runDoctorChecks(
          parseEnvironment(await runtime.loadEnvironment()),
          {
            ...runtime.doctorChecks,
            live: options.live === true,
          },
        );
      } catch (error) {
        result = createConfigurationErrorResult(requestedMode, error);
      }

      runtime.writeOut(
        `${formatDoctorResult(result, { json: options.json === true })}\n`,
      );
      runtime.setExitCode(result.canRunRequestedMode ? 0 : 2);
    });

  const snapshotCommand = program
    .command("snapshot")
    .description("Manage dossier snapshots: save, list, compare.");

  snapshotCommand
    .command("save")
    .description("Save a company dossier snapshot.")
    .argument("[companyNumber]", "Companies House company number.")
    .option("--snapshot-dir <path>", "Directory for snapshot files.")
    .action(
      async (companyNumber: string, options: SnapshotDirectoryOptions) => {
        try {
          await runSnapshotSaveCommand(runtime, companyNumber, options);
        } catch (error) {
          writeError(runtime, error, { json: true });
        }
      },
    );

  snapshotCommand
    .command("list")
    .description("List saved company dossier snapshots.")
    .argument("[companyNumber]", "Companies House company number.")
    .option("--snapshot-dir <path>", "Directory for snapshot files.")
    .action(
      async (companyNumber: string, options: SnapshotDirectoryOptions) => {
        try {
          await runSnapshotListCommand(runtime, companyNumber, options);
        } catch (error) {
          writeError(runtime, error, { json: true });
        }
      },
    );

  snapshotCommand
    .command("compare")
    .description("Compare two saved company dossier snapshots.")
    .argument("[before]", "Earlier snapshot file path.")
    .argument("[after]", "Later snapshot file path.")
    .action(async (before: string | undefined, after: string | undefined) => {
      try {
        await runSnapshotCompareCommand(runtime, before, after);
      } catch (error) {
        writeError(runtime, error, { json: true });
      }
    });

  program
    .command("mcp")
    .description("Start the dossier MCP service.")
    .action(async () => {
      try {
        await runMcpCommand(runtime);
      } catch (error) {
        writeError(runtime, error, { json: false });
      }
    });

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  dependencies?: CliDependencies,
): Promise<void> {
  const runtime = createRuntime(dependencies);
  const program = createProgram(dependencies);

  configureManagedParserOutput(program, runtime);

  try {
    await program.parseAsync(Array.from(argv));
  } catch (error) {
    if (error instanceof CommanderError) {
      if (isCommanderDisplayExit(error)) {
        runtime.setExitCode(0);

        return;
      }

      writeError(runtime, commanderParserError(error), { json: true });

      return;
    }

    throw error;
  }
}

function isExecutableEntrypoint(
  argv: readonly string[] = process.argv,
): boolean {
  const entrypoint = argv[1];

  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isExecutableEntrypoint()) {
  await runCli();
}
