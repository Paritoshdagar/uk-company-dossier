import { afterEach, describe, expect, it } from "vitest";

const originalEnvironment = process.env;

afterEach(() => {
  process.env = originalEnvironment;
});

describe("dossier CLI", () => {
  it("shows commands in help without reading or requiring an API key", async () => {
    process.env = new Proxy<NodeJS.ProcessEnv>(
      {},
      {
        get: (_target, property) => {
          if (
            typeof property === "string" &&
            /api.*key|key.*api/i.test(property)
          ) {
            throw new Error("CLI help attempted to read an API key");
          }

          return undefined;
        },
      },
    );

    const { createProgram } = await import("../../src/cli/main.js");
    const output: string[] = [];
    const program = createProgram();

    program.configureOutput({
      writeErr: (text) => {
        output.push(text);
      },
      writeOut: (text) => {
        output.push(text);
      },
    });
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "dossier", "--help"]),
    ).rejects.toMatchObject({
      code: "commander.helpDisplayed",
    });

    const help = output.join("");

    expect(help).toContain("dossier");
    expect(help).toContain("doctor");
    expect(help).toContain("snapshot");
    expect(help).toContain("mcp");
    expect(help).not.toMatch(/api[ -]?key/i);
  });

  it("runs doctor JSON output without exposing the configured API key", async () => {
    const secret = "do-not-print-from-cli-doctor";
    const { createProgram } = await import("../../src/cli/main.js");
    const output: string[] = [];
    let exitCode: number | undefined;
    const program = createProgram({
      loadEnvironment: () => ({
        COMPANIES_HOUSE_API_KEY: secret,
      }),
      setExitCode: (code) => {
        exitCode = code;
      },
      writeErr: (text) => {
        output.push(text);
      },
      writeOut: (text) => {
        output.push(text);
      },
    });

    await program.parseAsync(["node", "dossier", "doctor", "--json"]);

    const doctorOutput = output.join("");

    expect(exitCode).toBe(0);
    expect(doctorOutput).toContain('"readiness": "live-api-ready"');
    expect(doctorOutput).toContain('"configured": true');
    expect(doctorOutput).not.toContain(secret);
    expect(doctorOutput).not.toContain(String(secret.length));
  });
});
