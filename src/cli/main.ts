#!/usr/bin/env node

import { pathToFileURL } from "node:url";

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

  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isExecutableEntrypoint()) {
  await createProgram().parseAsync(process.argv);
}
