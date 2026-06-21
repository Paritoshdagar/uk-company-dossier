import { randomUUID } from "node:crypto";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactSecretText } from "../contracts/errors.js";
import type { ParsedEnvironment } from "../config/environment.js";

export type DoctorReadiness = "fixture-ready" | "live-api-ready" | "mcp-ready";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly message: string;
  readonly metadata?: Record<string, boolean | string>;
  readonly status: DoctorCheckStatus;
}

export interface LiveValidationResult {
  readonly message?: string;
  readonly ok: boolean;
  readonly status?: number;
}

export interface DoctorCheckDependencies {
  readonly checkFixtureAvailability?: () => Promise<boolean>;
  readonly checkMcpServerModule?: () => Promise<boolean>;
  readonly checkTemporaryDirectory?: () => Promise<boolean>;
  readonly initialiseMcpStdio?: () => Promise<boolean>;
  readonly live?: boolean;
  readonly liveTimeoutMs?: number;
  readonly liveValidator?: (
    config: ParsedEnvironment,
    options: { readonly timeoutMs: number },
  ) => Promise<LiveValidationResult>;
  readonly nodeVersion?: string;
}

export interface DoctorResult {
  readonly canRunRequestedMode: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly readiness: DoctorReadiness;
  readonly requestedMode: "default" | "live";
}

export interface DoctorFormatOptions {
  readonly json: boolean;
}

const defaultLiveTimeoutMs = 5_000;
const fixturePath = join("tests", "fixtures");

function hasSupportedNodeVersion(nodeVersion: string): boolean {
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);

  return major === 22;
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecretText(error.message);
  }

  return redactSecretText(String(error));
}

function checkWithMessage(
  ok: boolean,
  id: string,
  passMessage: string,
  failMessage: string,
  metadata?: Record<string, boolean | string>,
): DoctorCheck {
  const check: {
    id: string;
    message: string;
    metadata?: Record<string, boolean | string>;
    status: DoctorCheckStatus;
  } = {
    id,
    message: ok ? passMessage : failMessage,
    status: ok ? "pass" : "fail",
  };

  if (metadata !== undefined) {
    check.metadata = metadata;
  }

  return check;
}

async function defaultCheckTemporaryDirectory(): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "dossier-doctor-"));

  try {
    await writeFile(join(directory, randomUUID()), "ok", { flag: "wx" });

    return true;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function defaultCheckFixtureAvailability(): Promise<boolean> {
  await access(join(process.cwd(), fixturePath), constants.R_OK);

  return true;
}

async function defaultCheckMcpServerModule(): Promise<boolean> {
  await import("@modelcontextprotocol/sdk/server/stdio.js");

  return true;
}

async function defaultLiveValidator(
  config: ParsedEnvironment,
  options: { readonly timeoutMs: number },
): Promise<LiveValidationResult> {
  const apiKey = config.getApiKey();

  if (apiKey === undefined) {
    return {
      message: "API key is not configured.",
      ok: false,
    };
  }

  const endpoint = new URL("/company/00000006", config.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      },
      signal: controller.signal,
    });

    return {
      message: `Companies House returned HTTP ${String(response.status)}.`,
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      message: safeMessage(error),
      ok: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runBooleanCheck(
  id: string,
  check: () => Promise<boolean>,
  passMessage: string,
  failMessage: string,
): Promise<DoctorCheck> {
  try {
    return checkWithMessage(await check(), id, passMessage, failMessage);
  } catch (error) {
    return {
      id,
      message: `${failMessage} ${safeMessage(error)}`,
      status: "fail",
    };
  }
}

export async function runDoctorChecks(
  config: ParsedEnvironment,
  dependencies: DoctorCheckDependencies = {},
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const requestedMode = dependencies.live === true ? "live" : "default";
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;

  checks.push(
    checkWithMessage(
      hasSupportedNodeVersion(nodeVersion),
      "node-version",
      `Node.js ${nodeVersion} satisfies >=22 <23.`,
      `Node.js ${nodeVersion} does not satisfy >=22 <23.`,
      { version: nodeVersion },
    ),
  );

  checks.push(
    await runBooleanCheck(
      "temporary-directory",
      dependencies.checkTemporaryDirectory ?? defaultCheckTemporaryDirectory,
      "Temporary directory is writable.",
      "Temporary directory is not writable.",
    ),
  );

  checks.push(
    await runBooleanCheck(
      "fixtures",
      dependencies.checkFixtureAvailability ?? defaultCheckFixtureAvailability,
      "Fixture data is available.",
      "Fixture data is not available.",
    ),
  );

  checks.push({
    id: "api-key",
    message: config.apiKeyConfigured
      ? "Companies House API key is configured."
      : "Companies House API key is not configured; fixture mode is available.",
    metadata: { configured: config.apiKeyConfigured },
    status: "pass",
  });

  checks.push({
    id: "api-base-url",
    message: "Companies House API base URL is configured.",
    metadata: { url: redactSecretText(config.apiBaseUrl) },
    status: "pass",
  });
  checks.push({
    id: "document-api-base-url",
    message: "Companies House document API base URL is configured.",
    metadata: { url: redactSecretText(config.documentApiBaseUrl) },
    status: "pass",
  });

  checks.push(
    await runBooleanCheck(
      "mcp-server-module",
      dependencies.checkMcpServerModule ?? defaultCheckMcpServerModule,
      "MCP stdio transport module is available.",
      "MCP stdio transport module is not available.",
    ),
  );

  let mcpStdioReady = false;

  if (dependencies.initialiseMcpStdio !== undefined) {
    const mcpStdioCheck = await runBooleanCheck(
      "mcp-stdio",
      dependencies.initialiseMcpStdio,
      "MCP stdio can initialise.",
      "MCP stdio cannot initialise.",
    );
    mcpStdioReady = mcpStdioCheck.status === "pass";
    checks.push(mcpStdioCheck);
  }

  let canRunRequestedMode = !checks.some((check) => check.status === "fail");

  if (dependencies.live === true) {
    if (!config.apiKeyConfigured) {
      checks.push({
        id: "live-api",
        message:
          "Live validation cannot run because the API key is not configured.",
        status: "fail",
      });
      canRunRequestedMode = false;
    } else {
      const validator = dependencies.liveValidator ?? defaultLiveValidator;
      const liveResult = await validator(config, {
        timeoutMs: dependencies.liveTimeoutMs ?? defaultLiveTimeoutMs,
      });
      const liveCheck: DoctorCheck = {
        id: "live-api",
        message:
          liveResult.message ??
          (liveResult.ok
            ? "Live Companies House validation succeeded."
            : "Live Companies House validation failed."),
        status: liveResult.ok ? "pass" : "fail",
      };
      checks.push(liveCheck);
      canRunRequestedMode = canRunRequestedMode && liveResult.ok;
    }
  }

  const readiness: DoctorReadiness = mcpStdioReady
    ? "mcp-ready"
    : config.apiKeyConfigured
      ? "live-api-ready"
      : "fixture-ready";

  return {
    canRunRequestedMode,
    checks,
    readiness,
    requestedMode,
  };
}

function findApiKeyConfigured(result: DoctorResult): boolean {
  const apiKeyCheck = result.checks.find((check) => check.id === "api-key");

  return apiKeyCheck?.metadata?.configured === true;
}

export function formatDoctorResult(
  result: DoctorResult,
  options: DoctorFormatOptions,
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    "Dossier doctor",
    `Readiness: ${result.readiness}`,
    `Requested mode: ${result.requestedMode}`,
    `API key configured: ${findApiKeyConfigured(result) ? "yes" : "no"}`,
    "",
    "Checks:",
  ];

  for (const check of result.checks) {
    lines.push(`- [${check.status}] ${check.id}: ${check.message}`);
  }

  return lines.join("\n");
}
