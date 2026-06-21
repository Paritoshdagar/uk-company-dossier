#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("dossier")
    .description("Build reproducible UK company dossiers.")
    .version("0.1.0");

  program.command("doctor").description("Check local dossier prerequisites.");
  program.command("snapshot").description("Create a company dossier snapshot.");
  program.command("mcp").description("Start the dossier MCP service.");

  return program;
}

function isExecutableEntrypoint(): boolean {
  const entrypoint = process.argv[1];

  if (entrypoint === undefined) {
    return false;
  }

  const entrypointRealPath = realPathOrUndefined(entrypoint);

  if (entrypointRealPath === undefined) {
    return false;
  }

  return entrypointRealPath === realpathSync(fileURLToPath(import.meta.url));
}

function realPathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isExpectedPathResolutionError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isExpectedPathResolutionError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

if (isExecutableEntrypoint()) {
  await createProgram().parseAsync(process.argv);
}
