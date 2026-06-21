export type DossierErrorCode =
  | "configuration_error"
  | "companies_house_http_error"
  | "resource_not_found_error"
  | "rate_limit_error"
  | "document_safety_error"
  | "snapshot_error";

export interface SafeErrorCause {
  readonly code?: string;
  readonly message?: string;
  readonly name?: string;
  readonly status?: number;
}

export interface DossierErrorOptions {
  readonly cause?: unknown;
  readonly retryAfterSeconds?: number;
  readonly status?: number;
}

export interface SerializedDossierError {
  readonly cause?: SafeErrorCause;
  readonly code: DossierErrorCode;
  readonly message: string;
  readonly name: string;
  readonly retryAfterSeconds?: number;
  readonly status?: number;
}

const redactionText = "[REDACTED]";
const authorizationPattern = /\b(authorization\s*[:=]\s*)[^\r\n]*/giu;
const apiKeyQueryPattern =
  /([?&](?:api[-_]?key|apikey|x-api-key)=)[^&#\s"']+/giu;
const sensitiveFieldPattern =
  "api[-_]?key|apikey|x-api-key|api[-_]?token|apitoken|access[-_]?token|accesstoken|refresh[-_]?token|refreshtoken|id[-_]?token|idtoken|token|secret|password|credential|client_secret|private_key";
const secretAssignmentPattern = new RegExp(
  `\\b((?:${sensitiveFieldPattern})\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&}]+)`,
  "giu",
);
const jsonSecretFieldPattern = new RegExp(
  `("?)(authorization|${sensitiveFieldPattern})\\1(\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,}&]+)`,
  "giu",
);

export function redactSecretText(value: string): string {
  return value
    .replace(jsonSecretFieldPattern, `$1$2$1$3"${redactionText}"`)
    .replace(authorizationPattern, `$1${redactionText}`)
    .replace(apiKeyQueryPattern, `$1${redactionText}`)
    .replace(secretAssignmentPattern, `$1${redactionText}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeStringMetadata(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return redactSecretText(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function safeStatusMetadata(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  ) {
    return value;
  }

  return undefined;
}

function safePrimitiveCauseMessage(cause: unknown): string | undefined {
  if (
    typeof cause === "string" ||
    typeof cause === "number" ||
    typeof cause === "boolean" ||
    typeof cause === "bigint" ||
    typeof cause === "symbol"
  ) {
    return redactSecretText(String(cause));
  }

  return undefined;
}

function createSafeCause(cause: unknown): SafeErrorCause | undefined {
  if (cause === undefined || cause === null) {
    return undefined;
  }

  if (cause instanceof Error) {
    return {
      message: redactSecretText(cause.message),
      name: cause.name,
    };
  }

  if (isRecord(cause)) {
    const safeCause: {
      code?: string;
      message?: string;
      name?: string;
      status?: number;
    } = {};
    const code = safeStringMetadata(cause.code);
    const message = safeStringMetadata(cause.message);
    const name = safeStringMetadata(cause.name);
    const status = safeStatusMetadata(cause.status);

    if (code !== undefined) {
      safeCause.code = code;
    }

    if (message !== undefined) {
      safeCause.message = message;
    }

    if (name !== undefined) {
      safeCause.name = name;
    }

    if (status !== undefined) {
      safeCause.status = status;
    }

    return Object.keys(safeCause).length > 0 ? safeCause : undefined;
  }

  const primitiveMessage = safePrimitiveCauseMessage(cause);

  if (primitiveMessage !== undefined) {
    return {
      message: primitiveMessage,
    };
  }

  return {
    message: "Non-error cause omitted.",
  };
}

export abstract class DossierError extends Error {
  public readonly code: DossierErrorCode;
  public readonly retryAfterSeconds?: number;
  public readonly safeCause?: SafeErrorCause;
  public readonly status?: number;

  protected constructor(
    code: DossierErrorCode,
    message: string,
    options: DossierErrorOptions = {},
  ) {
    super(redactSecretText(message));
    this.name = new.target.name;
    this.code = code;

    if (options.status !== undefined) {
      this.status = options.status;
    }

    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }

    const safeCause = createSafeCause(options.cause);

    if (safeCause !== undefined) {
      this.safeCause = safeCause;
    }
  }

  public toJSON(): SerializedDossierError {
    const serialized: {
      cause?: SafeErrorCause;
      code: DossierErrorCode;
      message: string;
      name: string;
      retryAfterSeconds?: number;
      status?: number;
    } = {
      code: this.code,
      message: this.message,
      name: this.name,
    };

    if (this.status !== undefined) {
      serialized.status = this.status;
    }

    if (this.retryAfterSeconds !== undefined) {
      serialized.retryAfterSeconds = this.retryAfterSeconds;
    }

    if (this.safeCause !== undefined) {
      serialized.cause = this.safeCause;
    }

    return serialized;
  }
}

export class ConfigurationError extends DossierError {
  public constructor(message: string, options?: DossierErrorOptions) {
    super("configuration_error", message, options);
  }
}

export class CompaniesHouseHttpError extends DossierError {
  public constructor(message: string, options?: DossierErrorOptions) {
    super("companies_house_http_error", message, options);
  }
}

export class ResourceNotFoundError extends DossierError {
  public constructor(message: string, options?: DossierErrorOptions) {
    super("resource_not_found_error", message, options);
  }
}

export class RateLimitError extends DossierError {
  public constructor(message: string, options?: DossierErrorOptions) {
    super("rate_limit_error", message, options);
  }
}

export class DocumentSafetyError extends DossierError {
  public constructor(message: string, options?: DossierErrorOptions) {
    super("document_safety_error", message, options);
  }
}

export class SnapshotError extends DossierError {
  public constructor(message: string, options?: DossierErrorOptions) {
    super("snapshot_error", message, options);
  }
}
