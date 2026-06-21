import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const skipHeavyEnvironment = {
  ...process.env,
  UK_COMPANY_DOSSIER_SKIP_HEAVY_GATES_FOR_TESTS: "1",
};

interface CommandResult {
  code: number | string;
  stderr: string;
  stdout: string;
}

async function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  try {
    const { stderr, stdout } = await execFileAsync(executable, [...args], {
      cwd,
      env: skipHeavyEnvironment,
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
): error is Error & { code?: number | string; stderr: string; stdout: string } {
  return (
    error instanceof Error &&
    "stderr" in error &&
    "stdout" in error &&
    typeof (error as { stderr?: unknown }).stderr === "string" &&
    typeof (error as { stdout?: unknown }).stdout === "string"
  );
}

async function createFixtureRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dossier-verify-gate-"));

  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: directory,
  });
  await execFileAsync("git", ["config", "user.name", "Verify Gate Test"], {
    cwd: directory,
  });
  await writeFile(join(directory, ".gitignore"), "node_modules/\n");
  await writeFile(join(directory, "README.md"), "# Fixture repo\n");
  await execFileAsync("git", ["add", ".gitignore", "README.md"], {
    cwd: directory,
  });

  return directory;
}

describe("cross-platform release verification gates", () => {
  it("uses cross-platform Node package scripts instead of Bash or chmod", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.build).toBe("node scripts/build.mjs");
    expect(packageJson.scripts["env:init"]).toBe("node scripts/init-env.mjs");
    expect(packageJson.scripts["verify:commit"]).toBe(
      "node scripts/verify-commit.mjs",
    );
    expect(packageJson.scripts["verify:push"]).toBe(
      "node scripts/verify-push.mjs",
    );
    expect(packageJson.scripts["verify:release"]).toBe(
      "node scripts/verify-release.mjs",
    );
    expect(Object.values(packageJson.scripts).join("\n")).not.toMatch(
      /\bbash\b|chmod|\.sh\b/u,
    );
  });

  it("keeps public usage docs free of Unix-only setup commands", async () => {
    const publicDocs = await Promise.all(
      [
        "README.md",
        "AGENTS.md",
        "docs/use-cases/non-technical-company-review.md",
        "docs/use-cases/technical-evidence-integration.md",
        "examples/non-technical/README.md",
        "examples/technical/README.md",
      ].map(async (relativePath) => ({
        relativePath,
        text: await readFile(join(repositoryRoot, relativePath), "utf8"),
      })),
    );

    for (const { relativePath, text } of publicDocs) {
      expect(text, relativePath).not.toMatch(/\bmkdir -p\b|\bcp \.env/u);
    }
  });

  it("keeps GitHub workflows suitable for hosted runners", async () => {
    const [ciWorkflow, releaseWorkflow] = await Promise.all([
      readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(
        join(repositoryRoot, ".github/workflows/release-readiness.yml"),
        "utf8",
      ),
    ]);

    expect(`${ciWorkflow}\n${releaseWorkflow}`).not.toContain("go install ");
    expect(`${ciWorkflow}\n${releaseWorkflow}`).toContain("go run ");
    expect(releaseWorkflow).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("rejects tracked credential files before running heavier checks", async () => {
    const directory = await createFixtureRepository();

    try {
      await writeFile(join(directory, ".env"), "COMPANIES_HOUSE_API_KEY=\n");
      await execFileAsync("git", ["add", ".env"], { cwd: directory });

      const result = await runCommand(
        process.execPath,
        [join(repositoryRoot, "scripts/verify-commit.mjs")],
        directory,
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Forbidden tracked path");
      expect(result.stderr).not.toMatch(/COMPANIES_HOUSE_API_KEY=\S+/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects tracked private planning directories", async () => {
    const directory = await createFixtureRepository();

    try {
      await writeFile(join(directory, "docs-superpowers-placeholder"), "");
      await mkdir(join(directory, "docs/superpowers"), { recursive: true });
      await writeFile(
        join(directory, "docs/superpowers/private.md"),
        "private planning\n",
      );
      await execFileAsync("git", ["add", "docs/superpowers/private.md"], {
        cwd: directory,
      });

      const result = await runCommand(
        process.execPath,
        [join(repositoryRoot, "scripts/verify-commit.mjs")],
        directory,
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Forbidden tracked path");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes schema-valid release evidence without credential material", async () => {
    const result = await runCommand(
      process.execPath,
      [join(repositoryRoot, "scripts/verify-release.mjs")],
      repositoryRoot,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Release evidence written");
    expect(result.stderr).not.toMatch(/api|key|secret|token|password/i);

    const evidence = await readFile(
      join(repositoryRoot, "release-evidence-private/release-evidence.json"),
      "utf8",
    );

    expect(evidence).not.toMatch(/COMPANIES_HOUSE_API_KEY|Authorization/u);
    expect(JSON.parse(evidence)).toMatchObject({
      repository: "uk-company-dossier",
      schemaVersion: "1.0.0",
    });
  });
});
