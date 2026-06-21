import { Buffer } from "node:buffer";

import {
  CompaniesHouseHttpError,
  DocumentSafetyError,
  RateLimitError,
  ResourceNotFoundError,
  redactSecretText,
} from "../contracts/errors.js";

export interface CompaniesHouseClientConfig {
  readonly apiBaseUrl: string;
  readonly getApiKey: () => string | undefined;
  readonly initialBackoffMs?: number;
  readonly jitterRatio?: number;
  readonly maxAttempts?: number;
  readonly maxBackoffMs?: number;
  readonly sensitiveQueryKeys?: readonly string[];
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export interface CompaniesHouseRequestLog {
  readonly attempt: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "GET";
  readonly url: string;
}

export interface CompaniesHouseLogger {
  request(metadata: CompaniesHouseRequestLog): void;
}

export interface CompaniesHouseClock {
  now(): Date;
}

export interface CompaniesHouseClientDependencies {
  readonly AbortController?: typeof AbortController;
  readonly clearTimeout?: typeof clearTimeout;
  readonly clock?: CompaniesHouseClock;
  readonly fetch?: typeof fetch;
  readonly jitter?: (jitterRangeMs: number) => number;
  readonly logger?: CompaniesHouseLogger;
  readonly setTimeout?: typeof setTimeout;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface CompaniesHouseJsonResponse<TData = unknown> {
  readonly data: TData;
  readonly finalUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBytes: Uint8Array;
  readonly rawText: string;
  readonly requestedUrl: string;
  readonly retrievedAt: string;
  readonly status: number;
}

export type CompaniesHouseBytesBody =
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>
  | ReadableStream<Uint8Array>;

export interface CompaniesHouseBytesRequestOptions {
  readonly accept?: string;
}

export interface CompaniesHouseBytesResponse {
  readonly body: CompaniesHouseBytesBody;
  readonly contentLength?: number | undefined;
  readonly contentType?: string | undefined;
  readonly finalUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestedUrl: string;
  readonly retrievedAt: string;
  readonly status: number;
}

export interface CompaniesHouseClient {
  requestBytes(
    pathOrUrl: string | URL,
    options?: CompaniesHouseBytesRequestOptions,
  ): Promise<CompaniesHouseBytesResponse>;
  requestJson<TData = unknown>(
    pathOrUrl: string | URL,
  ): Promise<CompaniesHouseJsonResponse<TData>>;
}

export interface RetryPlanInput {
  readonly attempt: number;
  readonly initialBackoffMs: number;
  readonly jitterMs?: number;
  readonly jitterRatio?: number;
  readonly maxAttempts: number;
  readonly maxBackoffMs: number;
  readonly nowMs: number;
  readonly retryAfterHeader?: string | null;
  readonly status?: number;
}

export type RetryPlan =
  | {
      readonly delayMs: number;
      readonly reason: "retry-after" | "retryable-status";
      readonly retry: true;
    }
  | {
      readonly reason: "max-attempts" | "non-retryable-status";
      readonly retry: false;
    };

const defaultTimeoutMs = 15_000;
const defaultMaxAttempts = 3;
const defaultInitialBackoffMs = 500;
const defaultMaxBackoffMs = 10_000;
const defaultJitterRatio = 0.2;
const defaultUserAgent = "uk-company-dossier/0.1";
const maxManualRedirects = 5;
const redactedValue = "[REDACTED]";
const retryableStatuses = new Set([429, 500, 502, 503, 504]);
const defaultSensitiveQueryKeys = [
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "access_token",
  "accesstoken",
  "access-token",
  "api_token",
  "apitoken",
  "api-token",
  "refresh_token",
  "refreshtoken",
  "refresh-token",
  "id_token",
  "idtoken",
  "id-token",
  "token",
  "secret",
  "password",
  "credential",
  "client_secret",
  "private_key",
] as const;

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replaceAll(/[-_]/gu, "");
}

function createSensitiveKeySet(
  extraKeys: readonly string[] = [],
): ReadonlySet<string> {
  return new Set(
    [...defaultSensitiveQueryKeys, ...extraKeys].map((key) =>
      normalizeSensitiveKey(key),
    ),
  );
}

export function redactRequestUrl(
  requestUrl: string | URL,
  sensitiveQueryKeys: readonly string[] = [],
): string {
  const sensitiveKeys = createSensitiveKeySet(sensitiveQueryKeys);

  try {
    const url = new URL(requestUrl);

    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKeys.has(normalizeSensitiveKey(key))) {
        url.searchParams.set(key, redactedValue);
      }
    }

    return url.toString();
  } catch {
    return redactSecretText(String(requestUrl));
  }
}

function parseRetryAfterHeader(
  retryAfterHeader: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (retryAfterHeader === null || retryAfterHeader === undefined) {
    return undefined;
  }

  const trimmed = retryAfterHeader.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const seconds = Number(trimmed);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const dateMs = Date.parse(trimmed);

  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }

  return undefined;
}

function boundedJitter(
  baseDelayMs: number,
  jitterRatio: number,
  jitterMs: number,
): number {
  const jitterRangeMs = Math.max(0, Math.round(baseDelayMs * jitterRatio));

  return Math.min(Math.max(0, Math.round(jitterMs)), jitterRangeMs);
}

function exponentialDelay(input: RetryPlanInput): number {
  const exponent = Math.max(0, input.attempt - 1);
  const baseDelayMs = Math.min(
    input.maxBackoffMs,
    input.initialBackoffMs * 2 ** exponent,
  );
  const delayWithJitter =
    baseDelayMs +
    boundedJitter(
      baseDelayMs,
      input.jitterRatio ?? defaultJitterRatio,
      input.jitterMs ?? 0,
    );

  return Math.min(input.maxBackoffMs, delayWithJitter);
}

export function getRetryPlan(input: RetryPlanInput): RetryPlan {
  if (
    input.status === undefined ||
    !retryableStatuses.has(input.status) ||
    input.attempt >= input.maxAttempts
  ) {
    return {
      reason:
        input.attempt >= input.maxAttempts
          ? "max-attempts"
          : "non-retryable-status",
      retry: false,
    };
  }

  const retryAfterDelayMs = parseRetryAfterHeader(
    input.retryAfterHeader,
    input.nowMs,
  );

  if (retryAfterDelayMs !== undefined) {
    return {
      delayMs: Math.min(input.maxBackoffMs, retryAfterDelayMs),
      reason: "retry-after",
      retry: true,
    };
  }

  return {
    delayMs: exponentialDelay(input),
    reason: "retryable-status",
    retry: true,
  };
}

function retryAfterSeconds(
  retryAfterHeader: string | null,
  nowMs: number,
): number | undefined {
  const retryAfterMs = parseRetryAfterHeader(retryAfterHeader, nowMs);

  return retryAfterMs === undefined ? undefined : retryAfterMs / 1_000;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};

  headers.forEach((value, key) => {
    record[key] = value;
  });

  return record;
}

function resolveRequestUrl(pathOrUrl: string | URL, apiBaseUrl: string): URL {
  const baseUrl = new URL(apiBaseUrl);
  const requestUrl = new URL(pathOrUrl, baseUrl);

  if (requestUrl.origin !== baseUrl.origin) {
    throw new CompaniesHouseHttpError(
      "Companies House request URL must use the configured Companies House API origin.",
    );
  }

  return requestUrl;
}

function createFetchHeaders(
  apiKey: string,
  userAgent: string,
  accept = "application/json",
): Headers {
  return new Headers({
    Accept: accept,
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "User-Agent": userAgent,
  });
}

function loggedHeaders(
  userAgent: string,
  accept = "application/json",
): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": userAgent,
  };
}

function safeHttpMessage(status: number): string {
  return `Companies House request failed with HTTP ${String(status)}.`;
}

function httpErrorForStatus(
  status: number,
  retryAfterHeader: string | null,
  nowMs: number,
): CompaniesHouseHttpError | RateLimitError | ResourceNotFoundError {
  if (status === 404) {
    return new ResourceNotFoundError(
      "Companies House resource was not found.",
      {
        status,
      },
    );
  }

  if (status === 429) {
    const retryAfter = retryAfterSeconds(retryAfterHeader, nowMs);
    const options: {
      retryAfterSeconds?: number;
      status: number;
    } = { status };

    if (retryAfter !== undefined) {
      options.retryAfterSeconds = retryAfter;
    }

    return new RateLimitError(
      "Companies House rate limit was exceeded.",
      options,
    );
  }

  return new CompaniesHouseHttpError(safeHttpMessage(status), { status });
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

interface FetchWithTimeoutOptions {
  readonly AbortControllerCtor: typeof AbortController | undefined;
  readonly clearTimeoutFn: typeof clearTimeout;
  readonly fetchFn: typeof fetch;
  readonly headers: Headers;
  readonly redirect?: RequestRedirect;
  readonly setTimeoutFn: typeof setTimeout;
  readonly timeoutMs: number;
  readonly url: URL;
}

async function fetchWithTimeout(
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const init: RequestInit = {
    headers: options.headers,
    method: "GET",
  };

  if (options.redirect !== undefined) {
    init.redirect = options.redirect;
  }

  if (options.AbortControllerCtor === undefined) {
    return options.fetchFn(options.url, init);
  }

  const controller = new options.AbortControllerCtor();
  const timeout = options.setTimeoutFn(() => {
    controller.abort(
      new DOMException(
        `Companies House request timed out after ${String(options.timeoutMs)}ms.`,
        "TimeoutError",
      ),
    );
  }, options.timeoutMs);

  try {
    return await options.fetchFn(options.url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    options.clearTimeoutFn(timeout);
  }
}

function contentLengthFromHeaders(headers: Headers): number | undefined {
  const value = headers.get("content-length");

  if (value === null || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function redirectedUrl(
  response: Response,
  requestedUrl: string,
  apiBaseUrl: string,
): URL {
  const location = response.headers.get("location");

  if (location === null || location.trim().length === 0) {
    throw new CompaniesHouseHttpError(
      "Companies House redirect response did not include a Location header.",
      { status: response.status },
    );
  }

  const redirectUrl = new URL(location, requestedUrl);
  const baseUrl = new URL(apiBaseUrl);

  if (redirectUrl.origin !== baseUrl.origin) {
    throw new DocumentSafetyError(
      "Companies House redirect URL must use the configured Companies House API origin.",
      { status: response.status },
    );
  }

  return redirectUrl;
}

function bytesResponseFromFetch(
  response: Response,
  requestedUrl: string,
  retrievedAt: string,
): CompaniesHouseBytesResponse {
  return {
    body: response.body ?? [],
    contentLength: contentLengthFromHeaders(response.headers),
    contentType: response.headers.get("content-type") ?? undefined,
    finalUrl: response.url === "" ? requestedUrl : response.url,
    headers: headersToRecord(response.headers),
    requestedUrl,
    retrievedAt,
    status: response.status,
  };
}

function safeCauseFromMalformedJson(): {
  readonly message: string;
  readonly name: string;
} {
  return {
    message: "JSON parse failed.",
    name: "SyntaxError",
  };
}

async function parseJsonResponse<TData>(
  response: Response,
  requestedUrl: string,
  retrievedAt: string,
): Promise<CompaniesHouseJsonResponse<TData>> {
  const rawBytes = new Uint8Array(await response.arrayBuffer());
  const rawText = new TextDecoder().decode(rawBytes);
  let data: TData;

  try {
    data = JSON.parse(rawText) as TData;
  } catch {
    throw new CompaniesHouseHttpError(
      "Companies House response contained malformed JSON.",
      {
        cause: safeCauseFromMalformedJson(),
        status: response.status,
      },
    );
  }

  return {
    data,
    finalUrl: response.url === "" ? requestedUrl : response.url,
    headers: headersToRecord(response.headers),
    rawBytes,
    rawText,
    requestedUrl,
    retrievedAt,
    status: response.status,
  };
}

export function createCompaniesHouseClient(
  config: CompaniesHouseClientConfig,
  dependencies: CompaniesHouseClientDependencies = {},
): CompaniesHouseClient {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const clock = dependencies.clock ?? { now: () => new Date() };
  const userAgent = config.userAgent ?? defaultUserAgent;
  const timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
  const maxAttempts = config.maxAttempts ?? defaultMaxAttempts;
  const initialBackoffMs = config.initialBackoffMs ?? defaultInitialBackoffMs;
  const maxBackoffMs = config.maxBackoffMs ?? defaultMaxBackoffMs;
  const jitterRatio = config.jitterRatio ?? defaultJitterRatio;
  const jitter = dependencies.jitter ?? (() => 0);
  const clearTimeoutFn = dependencies.clearTimeout ?? clearTimeout;
  const setTimeoutFn = dependencies.setTimeout ?? setTimeout;
  const AbortControllerCtor =
    dependencies.AbortController ?? globalThis.AbortController;

  return {
    async requestBytes(
      pathOrUrl: string | URL,
      options: CompaniesHouseBytesRequestOptions = {},
    ): Promise<CompaniesHouseBytesResponse> {
      const initialUrl = resolveRequestUrl(pathOrUrl, config.apiBaseUrl);
      const requestedUrl = initialUrl.toString();
      const redactedUrl = redactRequestUrl(
        requestedUrl,
        config.sensitiveQueryKeys,
      );
      const apiKey = config.getApiKey();
      const accept = options.accept ?? "application/octet-stream";

      if (apiKey === undefined) {
        throw new CompaniesHouseHttpError(
          "Companies House API key is not configured.",
        );
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let url = initialUrl;

        dependencies.logger?.request({
          attempt,
          headers: loggedHeaders(userAgent, accept),
          method: "GET",
          url: redactedUrl,
        });

        for (let redirectCount = 0; ; redirectCount += 1) {
          const headers = createFetchHeaders(apiKey, userAgent, accept);
          let response: Response;

          try {
            response = await fetchWithTimeout({
              AbortControllerCtor,
              clearTimeoutFn,
              fetchFn,
              headers,
              redirect: "manual",
              setTimeoutFn,
              timeoutMs,
              url,
            });
          } catch (error) {
            throw new CompaniesHouseHttpError(
              `Companies House request to ${redactedUrl} failed before receiving a response.`,
              { cause: error },
            );
          }

          if (response.ok) {
            return bytesResponseFromFetch(
              response,
              url.toString(),
              clock.now().toISOString(),
            );
          }

          if (isRedirectStatus(response.status)) {
            if (redirectCount >= maxManualRedirects) {
              throw new CompaniesHouseHttpError(
                "Companies House request exceeded the manual redirect limit.",
                { status: response.status },
              );
            }

            url = redirectedUrl(response, url.toString(), config.apiBaseUrl);
            continue;
          }

          if (response.status === 404) {
            throw httpErrorForStatus(
              response.status,
              null,
              clock.now().getTime(),
            );
          }

          const retryPlan = getRetryPlan({
            attempt,
            initialBackoffMs,
            jitterMs: jitter(
              Math.max(
                0,
                Math.round(
                  Math.min(
                    maxBackoffMs,
                    initialBackoffMs * 2 ** Math.max(0, attempt - 1),
                  ) * jitterRatio,
                ),
              ),
            ),
            jitterRatio,
            maxAttempts,
            maxBackoffMs,
            nowMs: clock.now().getTime(),
            retryAfterHeader: response.headers.get("retry-after"),
            status: response.status,
          });

          if (retryPlan.retry) {
            await sleep(retryPlan.delayMs);
            break;
          }

          throw httpErrorForStatus(
            response.status,
            response.headers.get("retry-after"),
            clock.now().getTime(),
          );
        }
      }

      throw new CompaniesHouseHttpError(
        "Companies House request exhausted the retry budget.",
      );
    },

    async requestJson<TData = unknown>(
      pathOrUrl: string | URL,
    ): Promise<CompaniesHouseJsonResponse<TData>> {
      const url = resolveRequestUrl(pathOrUrl, config.apiBaseUrl);
      const requestedUrl = url.toString();
      const redactedUrl = redactRequestUrl(
        requestedUrl,
        config.sensitiveQueryKeys,
      );
      const apiKey = config.getApiKey();

      if (apiKey === undefined) {
        throw new CompaniesHouseHttpError(
          "Companies House API key is not configured.",
        );
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const headers = createFetchHeaders(apiKey, userAgent);

        dependencies.logger?.request({
          attempt,
          headers: loggedHeaders(userAgent),
          method: "GET",
          url: redactedUrl,
        });

        let response: Response;

        try {
          response = await fetchWithTimeout({
            AbortControllerCtor,
            clearTimeoutFn,
            fetchFn,
            headers,
            setTimeoutFn,
            timeoutMs,
            url,
          });
        } catch (error) {
          throw new CompaniesHouseHttpError(
            `Companies House request to ${redactedUrl} failed before receiving a response.`,
            { cause: error },
          );
        }

        if (response.ok) {
          return parseJsonResponse<TData>(
            response,
            requestedUrl,
            clock.now().toISOString(),
          );
        }

        if (response.status === 404) {
          throw httpErrorForStatus(
            response.status,
            null,
            clock.now().getTime(),
          );
        }

        const retryPlan = getRetryPlan({
          attempt,
          initialBackoffMs,
          jitterMs: jitter(
            Math.max(
              0,
              Math.round(
                Math.min(
                  maxBackoffMs,
                  initialBackoffMs * 2 ** Math.max(0, attempt - 1),
                ) * jitterRatio,
              ),
            ),
          ),
          jitterRatio,
          maxAttempts,
          maxBackoffMs,
          nowMs: clock.now().getTime(),
          retryAfterHeader: response.headers.get("retry-after"),
          status: response.status,
        });

        if (retryPlan.retry) {
          await sleep(retryPlan.delayMs);
          continue;
        }

        throw httpErrorForStatus(
          response.status,
          response.headers.get("retry-after"),
          clock.now().getTime(),
        );
      }

      throw new CompaniesHouseHttpError(
        "Companies House request exhausted the retry budget.",
      );
    },
  };
}
