import {
  companyDossierSchema,
  type CompanyDossier,
} from "../contracts/company-evidence.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

export function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const sortedValue: Record<string, unknown> = {};

  for (const key of Object.keys(value).sort()) {
    sortedValue[key] = stableJsonValue(value[key]);
  }

  return sortedValue;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value), null, 2);
}

export function renderCompanyDossierJson(dossier: CompanyDossier): string {
  const validatedDossier = companyDossierSchema.parse(dossier);

  return `${stableJsonStringify(validatedDossier)}\n`;
}
