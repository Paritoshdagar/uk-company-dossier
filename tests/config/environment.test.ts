import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../../src/contracts/errors.js";
import {
  DEFAULT_COMPANIES_HOUSE_API_BASE_URL,
  DEFAULT_COMPANIES_HOUSE_DOCUMENT_API_BASE_URL,
  parseEnvironment,
} from "../../src/config/environment.js";

describe("environment configuration", () => {
  it("uses the Companies House API defaults when URLs are omitted", () => {
    const config = parseEnvironment({});

    expect(config.apiBaseUrl).toBe(DEFAULT_COMPANIES_HOUSE_API_BASE_URL);
    expect(config.documentApiBaseUrl).toBe(
      DEFAULT_COMPANIES_HOUSE_DOCUMENT_API_BASE_URL,
    );
  });

  it("treats a whitespace-only API key as absent", () => {
    const config = parseEnvironment({
      COMPANIES_HOUSE_API_KEY: "   \n\t  ",
    });

    expect(config.apiKeyConfigured).toBe(false);
    expect(config.getApiKey()).toBeUndefined();
  });

  it("allows HTTP base URLs only for local test hosts", () => {
    const config = parseEnvironment({
      COMPANIES_HOUSE_API_BASE_URL: "http://localhost:4010",
      COMPANIES_HOUSE_DOCUMENT_API_BASE_URL: "http://[::1]:4011",
    });

    expect(config.apiBaseUrl).toBe("http://localhost:4010");
    expect(config.documentApiBaseUrl).toBe("http://[::1]:4011");
  });

  it("rejects non-HTTPS base URLs for remote hosts", () => {
    expect(() =>
      parseEnvironment({
        COMPANIES_HOUSE_API_BASE_URL: "http://api.example.test",
      }),
    ).toThrow(ConfigurationError);
  });

  it("does not serialise configured API keys in parsed config or errors", () => {
    const secret = "do-not-print-this-company-house-key";
    const config = parseEnvironment({
      COMPANIES_HOUSE_API_KEY: `  ${secret}  `,
    });

    expect(config.apiKeyConfigured).toBe(true);
    expect(config.getApiKey()).toBe(secret);
    expect(JSON.stringify(config)).not.toContain(secret);

    let error: unknown;
    try {
      parseEnvironment({
        COMPANIES_HOUSE_API_KEY: secret,
        COMPANIES_HOUSE_DOCUMENT_API_BASE_URL: "not a url",
      });
    } catch (caught) {
      error = caught;
    }

    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });
});
