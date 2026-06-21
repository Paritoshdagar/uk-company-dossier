import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const packageExportSmokeTimeoutMs = 20_000;

async function execFileAtRepository(
  file: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execFile(file, [...args], {
    cwd: repositoryRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("published package contract surface", () => {
  it(
    "packages the contract exports, schema files, and notices in the npm tarball",
    async () => {
      const temporaryRoot = await mkdtemp(
        join(tmpdir(), "uk-company-dossier-package-"),
      );

      try {
        await execFileAtRepository(npmExecutable, ["run", "build"]);

        const { stdout } = await execFileAtRepository(npmExecutable, [
          "pack",
          "--pack-destination",
          temporaryRoot,
          "--silent",
        ]);
        const tarballName = stdout.trim().split(/\r?\n/u).at(-1);

        expect(tarballName).toMatch(/\.tgz$/u);

        const installRoot = join(temporaryRoot, "install");
        const runnerPath = join(installRoot, "runner.mjs");
        const tarballPath = join(temporaryRoot, tarballName ?? "");

        await mkdir(installRoot);
        await execFile(
          npmExecutable,
          [
            "install",
            "--silent",
            "--no-audit",
            "--package-lock=false",
            tarballPath,
          ],
          {
            cwd: installRoot,
            env: process.env,
            maxBuffer: 10 * 1024 * 1024,
          },
        );

        await writeFile(
          runnerPath,
          `
          import { readFile } from "node:fs/promises";
          import { dirname, join } from "node:path";
          import { createRequire } from "node:module";

          const require = createRequire(import.meta.url);
          const packageRoot = dirname(require.resolve("uk-company-dossier/package.json"));
          const companyEvidence = await import("uk-company-dossier/contracts/company-evidence");
          const errors = await import("uk-company-dossier/contracts/errors");
          const schema = require("uk-company-dossier/schemas/company-evidence.schema.json");
          const versionPath = require.resolve("uk-company-dossier/schemas/VERSION");
          const version = await readFile(versionPath, "utf8");
          const notice = await readFile(join(packageRoot, "NOTICE.md"), "utf8");
          const thirdPartyNotices = await readFile(join(packageRoot, "THIRD-PARTY-NOTICES.md"), "utf8");

          if (companyEvidence.COMPANY_EVIDENCE_SCHEMA_VERSION !== "1.0.0") {
            throw new Error("Unexpected exported schema version.");
          }

          if (typeof companyEvidence.companyDossierSchema?.parse !== "function") {
            throw new Error("Missing company dossier schema export.");
          }

          if (typeof errors.redactSecretText !== "function") {
            throw new Error("Missing error redaction export.");
          }

          if (schema.$id !== "https://raw.githubusercontent.com/Paritoshdagar/uk-company-dossier/v1.0.0/schemas/company-evidence.schema.json") {
            throw new Error("Unexpected JSON Schema $id.");
          }

          if (version !== "1.0.0\\n") {
            throw new Error("Unexpected schema VERSION file contents.");
          }

          if (notice.trim().length === 0 || thirdPartyNotices.trim().length === 0) {
            throw new Error("Expected notices to be included in the package.");
          }
        `,
          "utf8",
        );

        await execFile(process.execPath, [runnerPath], {
          cwd: installRoot,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        });

        expect(basename(tarballPath)).toBe(tarballName);
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
      }
    },
    packageExportSmokeTimeoutMs,
  );

  it("keeps JSON schemas and fixtures inside the repository formatting gate", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly scripts?: { readonly ["format:check"]?: string } };
    const formatCheck = packageJson.scripts?.["format:check"];

    expect(formatCheck).toContain("schemas/**/*.json");
    expect(formatCheck).toContain("tests/fixtures/**/*.json");
  });
});
