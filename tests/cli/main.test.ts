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
});
