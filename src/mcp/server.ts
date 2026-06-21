#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-deprecated -- The low-level SDK Server is used intentionally so the MCP surface can expose the hand-written bounded JSON Schemas and structured tool errors from tools.ts without protocol-level validation wrapping. */

import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  loadEnvironmentFromProcess,
  parseEnvironment,
  type EnvironmentInput,
  type ParsedEnvironment,
} from "../config/environment.js";
import { redactSecretText } from "../contracts/errors.js";
import {
  createDossierMcpTools,
  executeDossierMcpTool,
  type DossierMcpToolDependencies,
} from "./tools.js";

export interface DossierMcpServerOptions extends DossierMcpToolDependencies {
  readonly loadEnvironment?: () => EnvironmentInput | Promise<EnvironmentInput>;
  readonly logger?: (message: string) => void;
  readonly registerProcessSignals?: boolean;
  readonly transport?: Transport;
}

const serverInfo = {
  name: "uk-company-dossier",
  version: "0.1.0",
};

function stderrLogger(message: string): void {
  process.stderr.write(`${message}\n`);
}

function serverDependencies(
  options: DossierMcpServerOptions,
  environment: ParsedEnvironment | undefined,
): DossierMcpToolDependencies {
  return {
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.documentApiBaseUrl !== undefined
      ? { documentApiBaseUrl: options.documentApiBaseUrl }
      : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(options.gateway !== undefined ? { gateway: options.gateway } : {}),
    ...(options.maxDocumentBytes !== undefined
      ? { maxDocumentBytes: options.maxDocumentBytes }
      : {}),
    ...(options.maxSearchItemsPerPage !== undefined
      ? { maxSearchItemsPerPage: options.maxSearchItemsPerPage }
      : {}),
    ...(options.retrieveDocument !== undefined
      ? { retrieveDocument: options.retrieveDocument }
      : {}),
  };
}

export function createDossierMcpServer(
  dependencies: DossierMcpToolDependencies = {},
): Server {
  const server = new Server(serverInfo, {
    capabilities: {
      tools: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...createDossierMcpTools()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    executeDossierMcpTool(
      request.params.name,
      request.params.arguments ?? {},
      dependencies,
    ),
  );

  return server;
}

function registerCleanShutdown(
  server: Server,
  logger: (message: string) => void,
): () => void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) {
      return;
    }

    closing = true;
    logger(`Received ${signal}; shutting down company dossier MCP server.`);
    void server.close().finally(() => {
      process.exitCode = 0;
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
}

export async function startDossierMcpServer(
  options: DossierMcpServerOptions = {},
): Promise<Server> {
  const logger = options.logger ?? stderrLogger;
  const environment =
    options.environment ??
    parseEnvironment(
      await (options.loadEnvironment ?? loadEnvironmentFromProcess)(),
    );
  const server = createDossierMcpServer(
    serverDependencies(options, environment),
  );
  const cleanupSignals =
    options.registerProcessSignals === false
      ? undefined
      : registerCleanShutdown(server, logger);
  const transport = options.transport ?? new StdioServerTransport();

  transport.onerror = (error) => {
    logger(redactSecretText(error.message));
  };
  transport.onclose = () => {
    cleanupSignals?.();
  };

  await server.connect(transport);

  return server;
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
  await startDossierMcpServer().catch((error: unknown) => {
    process.stderr.write(
      `Error: ${redactSecretText(
        error instanceof Error ? error.message : String(error),
      )}\n`,
    );
    process.exitCode = 1;
  });
}
