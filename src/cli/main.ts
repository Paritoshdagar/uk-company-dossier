#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { Command } from "commander";

import {
  loadEnvironmentFromProcess,
  parseEnvironment,
  type EnvironmentInput,
} from "../config/environment.js";
import { redactSecretText } from "../contracts/errors.js";
import {
  formatDoctorResult,
  runDoctorChecks,
  type DoctorCheckDependencies,
  type DoctorResult,
} from "../doctor/checks.js";

export interface CliDependencies {
  readonly doctorChecks?: DoctorCheckDependencies;
  readonly loadEnvironment?: () => EnvironmentInput | Promise<EnvironmentInput>;
  readonly setExitCode?: (code: number) => void;
  readonly writeErr?: (text: string) => void;
  readonly writeOut?: (text: string) => void;
}

interface DoctorCommandOptions {
  readonly json?: boolean;
  readonly live?: boolean;
}

const defaultCliDependencies = {
  loadEnvironment: loadEnvironmentFromProcess,
  setExitCode: (code: number) => {
    process.exitCode = code;
  },
  writeErr: (text: string) => {
    process.stderr.write(text);
  },
  writeOut: (text: string) => {
    process.stdout.write(text);
  },
} satisfies Required<Omit<CliDependencies, "doctorChecks">>;

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

export function createProgram(dependencies: CliDependencies = {}): Command {
  const runtime = {
    ...defaultCliDependencies,
    ...dependencies,
  };
  const program = new Command();

  program
    .name("dossier")
    .description("Build reproducible UK company dossiers.")
    .version("0.1.0");

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
  program.command("snapshot").description("Create a company dossier snapshot.");
  program.command("mcp").description("Start the dossier MCP service.");

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  dependencies?: CliDependencies,
): Promise<void> {
  await createProgram(dependencies).parseAsync(Array.from(argv));
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
