import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("packaged dossier bin", () => {
  beforeAll(async () => {
    await rm(join(repositoryRoot, "dist"), {
      force: true,
      recursive: true,
    });
    await execFileAsync("npm", ["run", "build"], {
      cwd: repositoryRoot,
    });
  });

  async function expectHelpCommand(
    executable: string,
    args: string[],
  ): Promise<void> {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd: repositoryRoot,
    });

    expect(stderr).toBe("");
    expect(stdout).toContain("dossier");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("snapshot");
    expect(stdout).toContain("mcp");
  }

  it("prints help from the direct built module", async () => {
    await expectHelpCommand(process.execPath, ["dist/cli/main.js", "--help"]);
  });

  it("prints help from the direct launcher", async () => {
    await expectHelpCommand(join(repositoryRoot, "bin", "dossier.mjs"), [
      "--help",
    ]);
  });

  it("prints help when invoked through a symlinked bin path", async () => {
    const binDirectory = await mkdtemp(join(tmpdir(), "dossier-bin-"));
    const symlinkedBinPath = join(binDirectory, "dossier");

    await symlink(join(repositoryRoot, "bin", "dossier.mjs"), symlinkedBinPath);

    await expectHelpCommand(symlinkedBinPath, ["--help"]);
  });

  it("prints help from a local packed npx install", async () => {
    const packageDirectory = await mkdtemp(join(tmpdir(), "dossier-pack-"));
    const { stdout: packedFileName } = await execFileAsync(
      "npm",
      ["pack", "--pack-destination", packageDirectory, "--silent"],
      {
        cwd: repositoryRoot,
      },
    );
    const packedFilePath = join(packageDirectory, packedFileName.trim());

    await expectHelpCommand("npx", [
      "--yes",
      "--package",
      packedFilePath,
      "dossier",
      "--help",
    ]);
  });
});
