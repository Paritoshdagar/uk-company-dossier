import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CompaniesHouseHttpError,
  RateLimitError,
  ResourceNotFoundError,
} from "../../src/contracts/errors.js";
import {
  createCompaniesHouseClient,
  getRetryPlan,
  redactRequestUrl,
  type CompaniesHouseClientDependencies,
  type CompaniesHouseLogger,
  type CompaniesHouseRequestLog,
} from "../../src/companies-house/client.js";

const apiBaseUrl = "https://api.company-information.service.gov.uk";
const fakeApiKey = "fake-test-api-key-not-real";

function jsonResponse(
  body: string,
  init: ResponseInit & { readonly url?: string } = {},
): Response {
  const response = new Response(body, {
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
    status: init.status ?? 200,
  });

  if (init.url !== undefined) {
    Object.defineProperty(response, "url", { value: init.url });
  }

  return response;
}

function createHarness(
  responses: readonly (Response | Error)[],
  overrides: Partial<CompaniesHouseClientDependencies> = {},
): {
  readonly client: ReturnType<typeof createCompaniesHouseClient>;
  readonly fetchCalls: RequestInit[];
  readonly logEvents: CompaniesHouseRequestLog[];
  readonly sleepCalls: number[];
} {
  const pending = [...responses];
  const fetchCalls: RequestInit[] = [];
  const logEvents: CompaniesHouseRequestLog[] = [];
  const sleepCalls: number[] = [];
  const logger: CompaniesHouseLogger = {
    request: (metadata) => {
      logEvents.push(metadata);
    },
  };

  const dependencies: CompaniesHouseClientDependencies = {
    clock: {
      now: () => new Date("2026-02-03T04:05:06.789Z"),
    },
    fetch: (_url, init = {}) => {
      fetchCalls.push(init);
      const next = pending.shift();

      if (next === undefined) {
        return Promise.reject(new Error("Unexpected extra fetch call."));
      }

      if (next instanceof Error) {
        return Promise.reject(next);
      }

      return Promise.resolve(next);
    },
    jitter: () => 0,
    logger,
    sleep: (milliseconds) => {
      sleepCalls.push(milliseconds);

      return Promise.resolve();
    },
    ...overrides,
  };

  return {
    client: createCompaniesHouseClient(
      {
        apiBaseUrl,
        getApiKey: () => fakeApiKey,
        initialBackoffMs: 100,
        maxAttempts: 3,
        maxBackoffMs: 1_000,
        timeoutMs: 15_000,
      },
      dependencies,
    ),
    fetchCalls,
    logEvents,
    sleepCalls,
  };
}

async function expectRejectsWith<TError extends Error>(
  action: () => Promise<unknown>,
  errorType: new (...args: never[]) => TError,
): Promise<TError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(errorType);

    return error as TError;
  }

  throw new Error("Expected action to reject.");
}

describe("Companies House HTTP client", () => {
  it("uses API-key Basic authentication with the key followed by a colon", async () => {
    const { client, fetchCalls } = createHarness([
      jsonResponse('{"company_name":"EXAMPLE LIMITED"}'),
    ]);

    await client.requestJson("/company/00000006");

    expect(fetchCalls).toHaveLength(1);
    const headers = new Headers(fetchCalls[0]?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${fakeApiKey}:`).toString("base64")}`,
    );
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^uk-company-dossier\//u);
  });

  it("logs request metadata without Authorization or sensitive query values", async () => {
    const { client, logEvents } = createHarness([jsonResponse('{"ok":true}')]);

    await client.requestJson(
      "/company/00000006?api_key=do-not-log&access_token=hide-me&query=public",
    );

    expect(logEvents).toHaveLength(1);
    const logEvent = logEvents[0];

    if (logEvent === undefined) {
      throw new Error("Expected a request log event.");
    }

    expect(logEvent).toMatchObject({
      attempt: 1,
      method: "GET",
      url: `${apiBaseUrl}/company/00000006?api_key=%5BREDACTED%5D&access_token=%5BREDACTED%5D&query=public`,
    });
    expect(logEvent.headers.Accept).toBe("application/json");
    expect(logEvent.headers["User-Agent"]).toMatch(/^uk-company-dossier\//u);
    expect(JSON.stringify(logEvents)).not.toContain("do-not-log");
    expect(JSON.stringify(logEvents)).not.toContain("hide-me");
    expect(JSON.stringify(logEvents)).not.toMatch(/authorization/i);
  });

  it("returns parsed JSON with status, headers, URL metadata, retrieval time, and raw bytes", async () => {
    const rawBody =
      '{"company_name":"EXAMPLE LIMITED","company_number":"00000006"}';
    const finalUrl = `${apiBaseUrl}/company/00000006`;
    const { client } = createHarness([
      jsonResponse(rawBody, {
        headers: {
          etag: '"abc123"',
          "x-request-id": "request-123",
        },
        status: 200,
        url: finalUrl,
      }),
    ]);

    const result = await client.requestJson<{
      readonly company_name: string;
      readonly company_number: string;
    }>("/company/00000006");

    expect(result.data).toEqual({
      company_name: "EXAMPLE LIMITED",
      company_number: "00000006",
    });
    expect(result.status).toBe(200);
    expect(result.headers).toMatchObject({
      etag: '"abc123"',
      "x-request-id": "request-123",
    });
    expect(result.requestedUrl).toBe(finalUrl);
    expect(result.finalUrl).toBe(finalUrl);
    expect(result.retrievedAt).toBe("2026-02-03T04:05:06.789Z");
    expect(Buffer.from(result.rawBytes).toString("utf8")).toBe(rawBody);
    expect(result.rawText).toBe(rawBody);
  });

  it("maps 404 responses to ResourceNotFoundError without retrying", async () => {
    const { client, fetchCalls, sleepCalls } = createHarness([
      jsonResponse('{"error":"not found"}', { status: 404 }),
    ]);

    const error = await expectRejectsWith(
      () => client.requestJson("/company/00000000"),
      ResourceNotFoundError,
    );

    expect(error.status).toBe(404);
    expect(fetchCalls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it("honours Retry-After for 429 responses before succeeding", async () => {
    const rateLimitBody = readFileSync(
      new URL("../fixtures/companies-house/rate-limit.json", import.meta.url),
      "utf8",
    );
    const { client, fetchCalls, sleepCalls } = createHarness([
      jsonResponse(rateLimitBody, {
        headers: {
          "retry-after": "2",
        },
        status: 429,
      }),
      jsonResponse('{"ok":true}'),
    ]);

    const result = await client.requestJson("/company/00000006");

    expect(result.data).toEqual({ ok: true });
    expect(fetchCalls).toHaveLength(2);
    expect(sleepCalls).toEqual([2_000]);
  });

  it("uses capped exponential backoff with bounded deterministic jitter when Retry-After is absent", async () => {
    const { client, fetchCalls, sleepCalls } = createHarness(
      [
        jsonResponse('{"error":"rate limit"}', { status: 429 }),
        jsonResponse('{"ok":true}'),
      ],
      {
        jitter: (jitterRangeMs) => {
          expect(jitterRangeMs).toBe(20);

          return 9_999;
        },
      },
    );

    const result = await client.requestJson("/company/00000006");

    expect(result.data).toEqual({ ok: true });
    expect(fetchCalls).toHaveLength(2);
    expect(sleepCalls).toEqual([120]);
  });

  it("stops retrying retryable server responses after the configured maximum", async () => {
    const { client, fetchCalls, sleepCalls } = createHarness([
      jsonResponse('{"error":"bad gateway"}', { status: 502 }),
      jsonResponse('{"error":"bad gateway"}', { status: 502 }),
      jsonResponse('{"error":"bad gateway"}', { status: 502 }),
    ]);

    const error = await expectRejectsWith(
      () => client.requestJson("/company/00000006"),
      CompaniesHouseHttpError,
    );

    expect(error.status).toBe(502);
    expect(fetchCalls).toHaveLength(3);
    expect(sleepCalls).toEqual([100, 200]);
  });

  it.each([400, 401, 403])(
    "does not retry non-retryable %i responses",
    async (status) => {
      const { client, fetchCalls, sleepCalls } = createHarness([
        jsonResponse('{"error":"do not retry"}', { status }),
      ]);

      const error = await expectRejectsWith(
        () => client.requestJson("/company/00000006"),
        CompaniesHouseHttpError,
      );

      expect(error.status).toBe(status);
      expect(fetchCalls).toHaveLength(1);
      expect(sleepCalls).toEqual([]);
    },
  );

  it("returns RateLimitError after the 429 retry budget is exhausted", async () => {
    const { client, fetchCalls, sleepCalls } = createHarness([
      jsonResponse('{"error":"rate limited"}', {
        headers: {
          "retry-after": "1",
        },
        status: 429,
      }),
      jsonResponse('{"error":"rate limited"}', {
        headers: {
          "retry-after": "1",
        },
        status: 429,
      }),
      jsonResponse('{"error":"rate limited"}', {
        headers: {
          "retry-after": "1",
        },
        status: 429,
      }),
    ]);

    const error = await expectRejectsWith(
      () => client.requestJson("/company/00000006"),
      RateLimitError,
    );

    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(1);
    expect(fetchCalls).toHaveLength(3);
    expect(sleepCalls).toEqual([1_000, 1_000]);
  });

  it("wraps abort and timeout failures with a redacted safe cause", async () => {
    const { client } = createHarness([
      new DOMException(
        "Timeout waiting for access_token=secret-token",
        "AbortError",
      ),
    ]);

    const error = await expectRejectsWith(
      () => client.requestJson("/company/00000006?access_token=secret-token"),
      CompaniesHouseHttpError,
    );

    expect(error.safeCause).toEqual({
      message: "Timeout waiting for access_token=[REDACTED]",
      name: "AbortError",
    });
    expect(JSON.stringify(error)).not.toContain("secret-token");
  });

  it("rejects malformed JSON with a typed error that omits the response body", async () => {
    const { client } = createHarness([
      jsonResponse('{"private":"PRIVATE-BODY-FRAGMENT"', { status: 200 }),
    ]);

    const error = await expectRejectsWith(
      () => client.requestJson("/company/00000006"),
      CompaniesHouseHttpError,
    );

    expect(error.message).toContain("malformed JSON");
    expect(JSON.stringify(error)).not.toContain("PRIVATE-BODY-FRAGMENT");
  });

  it("does not copy JSON parser body snippets into malformed JSON error causes", async () => {
    const { client } = createHarness([
      jsonResponse("<html>PRIVATE-BODY-FRAGMENT</html>", { status: 200 }),
    ]);

    const error = await expectRejectsWith(
      () => client.requestJson("/company/00000006"),
      CompaniesHouseHttpError,
    );
    const serializedError = JSON.stringify(error);

    expect(error.safeCause).toEqual({
      message: "JSON parse failed.",
      name: "SyntaxError",
    });
    expect(serializedError).not.toContain("PRIVATE");
    expect(serializedError).not.toContain("PRIVATE-BODY-FRAGMENT");
    expect(serializedError).not.toContain("<html>");
    expect(serializedError).not.toContain("PRIV");
  });
});

describe("Companies House retry helpers", () => {
  it("redacts common sensitive request query parameters", () => {
    expect(
      redactRequestUrl(
        "https://example.test/search?apiKey=secret&token=hide&company=visible",
      ),
    ).toBe(
      "https://example.test/search?apiKey=%5BREDACTED%5D&token=%5BREDACTED%5D&company=visible",
    );
  });

  it("treats 500, 502, 503, and 504 as retryable statuses", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(
        getRetryPlan({
          attempt: 1,
          initialBackoffMs: 100,
          maxAttempts: 2,
          maxBackoffMs: 1_000,
          nowMs: Date.parse("2026-02-03T04:05:06.789Z"),
          status,
        }),
      ).toEqual({
        delayMs: 100,
        reason: "retryable-status",
        retry: true,
      });
    }
  });
});
