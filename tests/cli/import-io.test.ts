import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { execPackageCommand } from "../helpers/package-command.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("built CLI module import", () => {
  it("prints help without explicit filesystem path API calls", async () => {
    await execPackageCommand("npm", ["run", "build"], {
      cwd: repositoryRoot,
    });

    const guardDirectory = join(tmpdir(), "dossier-fs-guard");
    const guardPath = join(guardDirectory, "guard-fs.mjs");
    const runnerPath = join(guardDirectory, "run-help.mjs");
    const builtModuleUrl = pathToFileURL(
      join(repositoryRoot, "dist", "cli", "main.js"),
    ).href;

    await rm(guardDirectory, {
      force: true,
      recursive: true,
    });
    await mkdir(guardDirectory, {
      recursive: true,
    });
    await writeFile(
      guardPath,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "",
        "const guarded = (name) => () => {",
        "  throw new Error(`explicit fs path API called: ${name}`);",
        "};",
        "",
        'fs.realpathSync = guarded("realpathSync");',
        'fs.realpathSync.native = guarded("realpathSync.native");',
        "syncBuiltinESMExports();",
        "",
      ].join("\n"),
    );
    await writeFile(
      runnerPath,
      [
        `import { runCli } from ${JSON.stringify(builtModuleUrl)};`,
        'await runCli(["node", "dossier", "--help"]);',
        "",
      ].join("\n"),
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", guardPath, runnerPath],
      {
        cwd: repositoryRoot,
      },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("dossier");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("snapshot");
    expect(stdout).toContain("mcp");
  }, 20_000);
});
