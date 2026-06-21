import { describe, expect, it } from "vitest";

import { parseEnvironment } from "../../src/config/environment.js";
import {
  formatDoctorResult,
  runDoctorChecks,
  type DoctorCheckDependencies,
} from "../../src/doctor/checks.js";

function passingDependencies(
  overrides: Partial<DoctorCheckDependencies> = {},
): DoctorCheckDependencies {
  return {
    checkFixtureAvailability: () => Promise.resolve(true),
    checkMcpServerModule: () => Promise.resolve(true),
    checkTemporaryDirectory: () => Promise.resolve(true),
    nodeVersion: "22.20.0",
    ...overrides,
  };
}

describe("doctor checks", () => {
  it("is fixture-ready without an API key and does not perform live validation", async () => {
    let liveCalls = 0;
    const result = await runDoctorChecks(
      parseEnvironment({}),
      passingDependencies({
        liveValidator: () => {
          liveCalls += 1;
          return Promise.resolve({ ok: true });
        },
      }),
    );

    expect(result.readiness).toBe("fixture-ready");
    expect(result.canRunRequestedMode).toBe(true);
    expect(liveCalls).toBe(0);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "api-key",
        metadata: { configured: false },
      }),
    );
  });

  it("is live-api-ready when a syntactically present API key is configured", async () => {
    const result = await runDoctorChecks(
      parseEnvironment({
        COMPANIES_HOUSE_API_KEY: "present-but-not-printed",
      }),
      passingDependencies(),
    );

    expect(result.readiness).toBe("live-api-ready");
    expect(result.canRunRequestedMode).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "api-key",
        metadata: { configured: true },
      }),
    );
  });

  it("is mcp-ready when MCP stdio initialisation is available", async () => {
    const result = await runDoctorChecks(
      parseEnvironment({
        COMPANIES_HOUSE_API_KEY: "present-but-not-printed",
      }),
      passingDependencies({
        initialiseMcpStdio: () => Promise.resolve(true),
      }),
    );

    expect(result.readiness).toBe("mcp-ready");
    expect(result.canRunRequestedMode).toBe(true);
  });

  it("reports live mode as unavailable without a key", async () => {
    const result = await runDoctorChecks(
      parseEnvironment({}),
      passingDependencies({ live: true }),
    );

    expect(result.readiness).toBe("fixture-ready");
    expect(result.canRunRequestedMode).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "live-api",
        status: "fail",
      }),
    );
  });

  it("formats doctor output without the API key value or length", async () => {
    const secret = "hide-this-secret-key-with-length-37";
    const result = await runDoctorChecks(
      parseEnvironment({
        COMPANIES_HOUSE_API_KEY: secret,
      }),
      passingDependencies(),
    );

    const jsonOutput = formatDoctorResult(result, { json: true });
    const humanOutput = formatDoctorResult(result, { json: false });

    expect(jsonOutput).toContain('"readiness": "live-api-ready"');
    expect(jsonOutput).toContain('"configured": true');
    expect(jsonOutput).not.toContain(secret);
    expect(jsonOutput).not.toContain(String(secret.length));
    expect(humanOutput).toContain("Readiness: live-api-ready");
    expect(humanOutput).toContain("API key configured: yes");
    expect(humanOutput).not.toContain(secret);
    expect(humanOutput).not.toContain(String(secret.length));
    expect(humanOutput).not.toMatch(/key length/i);
  });
});
