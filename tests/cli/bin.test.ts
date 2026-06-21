import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("packaged dossier bin", () => {
  it("prints help when invoked through a symlinked bin path", async () => {
    await rm(join(repositoryRoot, "dist"), {
      force: true,
      recursive: true,
    });
    await execFileAsync("npm", ["run", "build"], {
      cwd: repositoryRoot,
    });

    const builtBinPath = join(repositoryRoot, "dist", "cli", "main.js");
    const binDirectory = await mkdtemp(join(tmpdir(), "dossier-bin-"));
    const symlinkedBinPath = join(binDirectory, "dossier");

    await symlink(builtBinPath, symlinkedBinPath);

    const { stdout, stderr } = await execFileAsync(symlinkedBinPath, [
      "--help",
    ]);

    expect(stderr).toBe("");
    expect(stdout).toContain("dossier");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("snapshot");
    expect(stdout).toContain("mcp");
  });
});
