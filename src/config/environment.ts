import { ConfigurationError } from "../contracts/errors.js";

export const DEFAULT_COMPANIES_HOUSE_API_BASE_URL =
  "https://api.company-information.service.gov.uk";
export const DEFAULT_COMPANIES_HOUSE_DOCUMENT_API_BASE_URL =
  "https://document-api.company-information.service.gov.uk";

export interface EnvironmentInput {
  readonly COMPANIES_HOUSE_API_KEY?: string;
  readonly COMPANIES_HOUSE_API_BASE_URL?: string;
  readonly COMPANIES_HOUSE_DOCUMENT_API_BASE_URL?: string;
}

export interface ParsedEnvironmentJson {
  readonly apiBaseUrl: string;
  readonly apiKeyConfigured: boolean;
  readonly documentApiBaseUrl: string;
}

export interface ParsedEnvironment extends ParsedEnvironmentJson {
  getApiKey(): string | undefined;
  toJSON(): ParsedEnvironmentJson;
}

export interface LoadEnvironmentOptions {
  readonly dotenvPath?: string;
}

const localHttpHostnames = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function trimmedValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function serialiseBaseUrl(url: URL): string {
  if (url.pathname === "/" && url.search === "" && url.hash === "") {
    return url.origin;
  }

  return url.href;
}

function parseBaseUrl(variableName: string, value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigurationError(
      `${variableName} must be a valid absolute URL.`,
      { cause: error },
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(
      `${variableName} must not include credentials.`,
    );
  }

  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localHttpHostnames.has(url.hostname))
  ) {
    throw new ConfigurationError(
      `${variableName} must use HTTPS unless the hostname is localhost, 127.0.0.1, or ::1.`,
    );
  }

  return serialiseBaseUrl(url);
}

export function parseEnvironment(env: EnvironmentInput): ParsedEnvironment {
  const apiKey = trimmedValue(env.COMPANIES_HOUSE_API_KEY);
  const apiBaseUrl = parseBaseUrl(
    "COMPANIES_HOUSE_API_BASE_URL",
    trimmedValue(env.COMPANIES_HOUSE_API_BASE_URL) ??
      DEFAULT_COMPANIES_HOUSE_API_BASE_URL,
  );
  const documentApiBaseUrl = parseBaseUrl(
    "COMPANIES_HOUSE_DOCUMENT_API_BASE_URL",
    trimmedValue(env.COMPANIES_HOUSE_DOCUMENT_API_BASE_URL) ??
      DEFAULT_COMPANIES_HOUSE_DOCUMENT_API_BASE_URL,
  );

  const serializableConfig: ParsedEnvironmentJson = {
    apiBaseUrl,
    apiKeyConfigured: apiKey !== undefined,
    documentApiBaseUrl,
  };

  return {
    ...serializableConfig,
    getApiKey: () => apiKey,
    toJSON: () => serializableConfig,
  };
}

export async function loadEnvironmentFromProcess(
  options: LoadEnvironmentOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const { config: loadDotenv } = await import("dotenv");

  if (options.dotenvPath === undefined) {
    loadDotenv({ quiet: true });
  } else {
    loadDotenv({
      path: options.dotenvPath,
      quiet: true,
    });
  }

  return process.env;
}
