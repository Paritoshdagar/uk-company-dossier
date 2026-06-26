import { execFile } from "node:child_process";
import type { ExecException } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  packageCommand,
  packageCommandOptions,
} from "../helpers/package-command.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

interface CommandResult {
  code: number | string;
  stderr: string;
  stdout: string;
}

async function runUnavailableCommand(
  executable: string,
  args: string[],
  options: { readonly shell?: boolean | string } = {},
): Promise<CommandResult> {
  try {
    const { stderr, stdout } = await execFileAsync(executable, args, {
      cwd: repositoryRoot,
      shell: options.shell,
    });

    return {
      code: 0,
      stderr,
      stdout,
    };
  } catch (error) {
    if (!isExecFailure(error)) {
      throw error;
    }

    return {
      code: error.code ?? "UNKNOWN",
      stderr: error.stderr,
      stdout: error.stdout,
    };
  }
}

function isExecFailure(
  error: unknown,
): error is ExecException & { stderr: string; stdout: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    "stderr" in error &&
    "stdout" in error
  );
}

function expectedMessage(capabilityName: string): string {
  return `${capabilityName} is unavailable in this scaffold.\n`;
}

function expectUnavailableResult(
  result: CommandResult,
  capabilityName: string,
): void {
  expect(result.code).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(expectedMessage(capabilityName));
  expect(result.stderr).not.toMatch(/api|key|secret|token|password/i);
}

describe("unavailable planned capability scripts", () => {
  it("exits 2 with a concise stderr message and no stdout", async () => {
    const result = await runUnavailableCommand(process.execPath, [
      "scripts/unavailable.mjs",
      "MCP service",
    ]);

    expectUnavailableResult(result, "MCP service");
  });
});

describe("available documentation quality scripts", () => {
  it.each([
    ["docs:links", "Documentation link checks passed.\n"],
    ["docs:mermaid", "Mermaid documentation checks passed.\n"],
  ])("%s exits 0 with a concise stdout message", async (scriptName, stdout) => {
    const result = await runUnavailableCommand(
      packageCommand("npm"),
      ["run", "--silent", scriptName],
      packageCommandOptions({}),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe("");
  });
});
