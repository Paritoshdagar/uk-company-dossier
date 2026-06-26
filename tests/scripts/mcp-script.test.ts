import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  packageCommand,
  packageCommandOptions,
} from "../helpers/package-command.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

interface ScriptManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

async function readMcpScript(): Promise<string> {
  const manifestText = await readFile(
    resolve(repositoryRoot, "package.json"),
    "utf8",
  );
  const manifest = JSON.parse(manifestText) as ScriptManifest;
  const mcpScript = manifest.scripts?.mcp;

  if (mcpScript === undefined) {
    throw new Error("package.json is missing an `mcp` script.");
  }

  return mcpScript;
}

interface RunResult {
  readonly stderr: string;
  readonly stdout: string;
}

async function runMcpScriptBriefly(): Promise<RunResult> {
  const options = packageCommandOptions({ cwd: repositoryRoot });
  const child = spawn(packageCommand("npm"), ["run", "--silent", "mcp"], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  // Track whether the process has already closed (e.g. the MCP server exits
  // on stdin EOF before the timeout elapses). Use a box so the async mutation
  // is visible after awaiting the timeout.
  const state = { closed: false };
  const closePromise = new Promise<void>((resolveExit) => {
    child.on("close", () => {
      state.closed = true;
      resolveExit();
    });
  });

  // Closing stdin lets a real stdio MCP server settle without a client.
  child.stdin.end();

  await new Promise<void>((resolveTimer) => {
    setTimeout(resolveTimer, 2_000);
  });

  if (!state.closed) {
    child.kill("SIGTERM");
    await closePromise;
  }

  return { stderr, stdout };
}

describe("mcp npm script", () => {
  it("delegates to the shipped CLI MCP entry, not the scaffold stub", async () => {
    const mcpScript = await readMcpScript();

    expect(mcpScript).not.toMatch(/unavailable\.mjs/u);
    expect(mcpScript).toMatch(/\bcli\b/u);
    expect(mcpScript).toMatch(/\bmcp\b/u);
  });

  it("does not claim the MCP capability is unavailable when launched", async () => {
    const { stderr, stdout } = await runMcpScriptBriefly();

    expect(stderr).not.toContain("is unavailable in this scaffold");
    expect(stdout).not.toContain("is unavailable in this scaffold");
  }, 10_000);
});
