import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  companyDossierSchema,
  companyIdentitySchema,
  type CompanyDossier,
  type EvidenceStatus,
  type Fact,
  type JsonValue,
} from "../contracts/company-evidence.js";
import { SnapshotError } from "../contracts/errors.js";
import {
  renderCompanyDossierJson,
  stableJsonStringify,
  stableJsonValue,
} from "../renderers/json-renderer.js";

export interface SnapshotStoreOptions {
  readonly snapshotDir: string;
}

export interface DossierSnapshotMetadata {
  readonly companyNumber: string;
  readonly fileName: string;
  readonly generatedAt: string;
  readonly path: string;
}

export interface SaveDossierSnapshotOptions extends SnapshotStoreOptions {
  readonly dossier: CompanyDossier;
}

export interface ReadDossierSnapshotOptions extends SnapshotStoreOptions {
  readonly fileName: string;
}

export interface ReadDossierSnapshotResult extends DossierSnapshotMetadata {
  readonly dossier: CompanyDossier;
}

export interface ListDossierSnapshotsOptions extends SnapshotStoreOptions {
  readonly companyNumber: string;
}

export interface CompareDossierSnapshotsOptions extends SnapshotStoreOptions {
  readonly afterFileName: string;
  readonly beforeFileName: string;
}

export interface SnapshotFactChange {
  readonly fact: Fact;
  readonly factId: string;
  readonly sectionKey: string;
}

export interface SnapshotChangedFact {
  readonly after: Fact;
  readonly before: Fact;
  readonly factId: string;
  readonly sectionKey: string;
}

export interface SnapshotSectionStatusChange {
  readonly afterStatus?: EvidenceStatus;
  readonly beforeStatus?: EvidenceStatus;
  readonly sectionKey: string;
}

export interface SnapshotOtherChange {
  readonly after?: JsonValue;
  readonly before?: JsonValue;
  readonly path: string;
}

export interface DossierSnapshotComparison {
  readonly addedFacts: readonly SnapshotFactChange[];
  readonly afterFileName: string;
  readonly beforeFileName: string;
  readonly changedFacts: readonly SnapshotChangedFact[];
  readonly hasChanges: boolean;
  readonly otherChanges: readonly SnapshotOtherChange[];
  readonly removedFacts: readonly SnapshotFactChange[];
  readonly sectionStatusChanges: readonly SnapshotSectionStatusChange[];
}

interface LocatedSnapshotFile {
  readonly path: string;
  readonly root: string;
}

interface CollectedFact {
  readonly fact: Fact;
  readonly factId: string;
  readonly sectionKey: string;
}

const fileSystemConstants = constants as typeof constants & {
  readonly O_NOFOLLOW?: number;
};
const noFollowOpenFlag = fileSystemConstants.O_NOFOLLOW ?? 0;
const snapshotFileNamePattern =
  /^[0-9A-Z]{8}--[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}-[0-9]{2})\.json$/u;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function snapshotError(message: string, cause?: unknown): SnapshotError {
  return cause === undefined
    ? new SnapshotError(message)
    : new SnapshotError(message, { cause });
}

function requireSnapshotRoot(snapshotDir: string): string {
  if (typeof snapshotDir !== "string" || snapshotDir.trim().length === 0) {
    throw snapshotError("Snapshot operations require an explicit snapshotDir.");
  }

  return resolve(snapshotDir);
}

function isInsideDirectory(root: string, candidatePath: string): boolean {
  const relativePath = relative(root, candidatePath);

  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function resolveSnapshotFile(
  snapshotDir: string,
  fileName: string,
): LocatedSnapshotFile {
  const root = requireSnapshotRoot(snapshotDir);

  if (
    fileName.trim().length === 0 ||
    isAbsolute(fileName) ||
    basename(fileName) !== fileName ||
    !snapshotFileNamePattern.test(fileName)
  ) {
    throw snapshotError("Snapshot file names must be confined JSON basenames.");
  }

  const snapshotPath = resolve(root, fileName);

  if (!isInsideDirectory(root, snapshotPath)) {
    throw snapshotError("Snapshot path escapes the configured snapshotDir.");
  }

  return {
    path: snapshotPath,
    root,
  };
}

function parseDossierForSnapshot(value: unknown): CompanyDossier {
  const result = companyDossierSchema.safeParse(value);

  if (!result.success) {
    throw snapshotError(
      "Snapshot dossier failed schema validation.",
      result.error,
    );
  }

  return result.data;
}

function parseCompanyNumber(companyNumber: string): string {
  const result = companyIdentitySchema.safeParse({ companyNumber });

  if (!result.success) {
    throw snapshotError(
      "Snapshot list operations require a normalized company number.",
      result.error,
    );
  }

  return result.data.companyNumber;
}

function safeGeneratedAtForFileName(generatedAtValue: string): string {
  return generatedAtValue.replaceAll(":", "-");
}

export function snapshotFileNameForDossier(dossier: CompanyDossier): string {
  const validatedDossier = parseDossierForSnapshot(dossier);

  return `${validatedDossier.company.companyNumber}--${safeGeneratedAtForFileName(validatedDossier.generatedAt)}.json`;
}

async function writeFileAtomically(
  root: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const targetPath = resolve(root, fileName);

  if (process.platform === "win32") {
    let targetCreated = false;

    try {
      const fileHandle = await open(
        targetPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      targetCreated = true;

      try {
        await fileHandle.writeFile(contents, "utf8");
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }

      return targetPath;
    } catch (error) {
      if (targetCreated) {
        await unlink(targetPath).catch(() => undefined);
      }

      if (isNodeError(error) && error.code === "EEXIST") {
        throw snapshotError(`Snapshot already exists: ${fileName}`, error);
      }

      throw error;
    }
  }

  const temporaryPath = resolve(root, `.${fileName}.${randomUUID()}.tmp`);
  let temporaryCreated = false;

  try {
    const fileHandle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;

    try {
      await fileHandle.writeFile(contents, "utf8");
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw snapshotError(`Snapshot already exists: ${fileName}`, error);
      }

      throw error;
    }

    await unlink(temporaryPath);

    return targetPath;
  } catch (error) {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }

    if (error instanceof SnapshotError) {
      throw error;
    }

    throw snapshotError("Failed to write snapshot atomically.", error);
  }
}

function metadataFor(
  path: string,
  fileName: string,
  dossier: CompanyDossier,
): DossierSnapshotMetadata {
  return {
    companyNumber: dossier.company.companyNumber,
    fileName,
    generatedAt: dossier.generatedAt,
    path,
  };
}

async function readRegularFileWithoutFollowingSymlinks(
  path: string,
): Promise<string> {
  const fileHandle = await open(path, constants.O_RDONLY | noFollowOpenFlag);

  try {
    const stat = await fileHandle.stat();

    if (!stat.isFile()) {
      throw snapshotError("Snapshot path must resolve to a regular file.");
    }

    return await fileHandle.readFile("utf8");
  } finally {
    await fileHandle.close();
  }
}

export async function saveDossierSnapshot(
  options: SaveDossierSnapshotOptions,
): Promise<DossierSnapshotMetadata> {
  const root = requireSnapshotRoot(options.snapshotDir);
  const dossier = parseDossierForSnapshot(options.dossier);
  const fileName = snapshotFileNameForDossier(dossier);

  await mkdir(root, { recursive: true });

  const { path } = resolveSnapshotFile(root, fileName);
  const savedPath = await writeFileAtomically(
    root,
    fileName,
    renderCompanyDossierJson(dossier),
  );

  if (savedPath !== path) {
    throw snapshotError("Snapshot writer produced an unexpected path.");
  }

  return metadataFor(savedPath, fileName, dossier);
}

export async function readDossierSnapshot(
  options: ReadDossierSnapshotOptions,
): Promise<ReadDossierSnapshotResult> {
  const { path } = resolveSnapshotFile(options.snapshotDir, options.fileName);

  try {
    const parsed = JSON.parse(
      await readRegularFileWithoutFollowingSymlinks(path),
    ) as unknown;
    const dossier = parseDossierForSnapshot(parsed);

    return {
      ...metadataFor(path, options.fileName, dossier),
      dossier,
    };
  } catch (error) {
    if (error instanceof SnapshotError) {
      throw error;
    }

    throw snapshotError("Failed to read snapshot.", error);
  }
}

export async function listDossierSnapshots(
  options: ListDossierSnapshotsOptions,
): Promise<readonly DossierSnapshotMetadata[]> {
  const root = requireSnapshotRoot(options.snapshotDir);
  const companyNumber = parseCompanyNumber(options.companyNumber);

  let entries: string[];

  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw snapshotError("Failed to list snapshots.", error);
  }

  const metadata: DossierSnapshotMetadata[] = [];

  for (const fileName of entries.sort()) {
    if (
      !fileName.startsWith(`${companyNumber}--`) ||
      !snapshotFileNamePattern.test(fileName)
    ) {
      continue;
    }

    const snapshot = await readDossierSnapshot({
      fileName,
      snapshotDir: root,
    });

    if (snapshot.companyNumber === companyNumber) {
      metadata.push({
        companyNumber: snapshot.companyNumber,
        fileName: snapshot.fileName,
        generatedAt: snapshot.generatedAt,
        path: snapshot.path,
      });
    }
  }

  return metadata;
}

function collectedFactKey(sectionKey: string, factId: string): string {
  return `${sectionKey}\u0000${factId}`;
}

function collectFacts(dossier: CompanyDossier): Map<string, CollectedFact[]> {
  const facts = new Map<string, CollectedFact[]>();

  for (const sectionKey of Object.keys(dossier.sections).sort()) {
    const section = dossier.sections[sectionKey];

    if (section === undefined) {
      continue;
    }

    for (const fact of section.facts) {
      const key = collectedFactKey(sectionKey, fact.id);
      const existingFacts = facts.get(key) ?? [];

      existingFacts.push({
        fact,
        factId: fact.id,
        sectionKey,
      });
      facts.set(key, existingFacts);
    }
  }

  return facts;
}

function compareFacts(
  before: CompanyDossier,
  after: CompanyDossier,
): {
  readonly addedFacts: readonly SnapshotFactChange[];
  readonly changedFacts: readonly SnapshotChangedFact[];
  readonly removedFacts: readonly SnapshotFactChange[];
} {
  const beforeFacts = collectFacts(before);
  const afterFacts = collectFacts(after);
  const addedFacts: SnapshotFactChange[] = [];
  const changedFacts: SnapshotChangedFact[] = [];
  const removedFacts: SnapshotFactChange[] = [];
  const factKeys = [
    ...new Set([...beforeFacts.keys(), ...afterFacts.keys()]),
  ].sort();

  for (const factKey of factKeys) {
    const beforeGroup = beforeFacts.get(factKey) ?? [];
    const afterGroup = afterFacts.get(factKey) ?? [];
    const unmatchedBefore: CollectedFact[] = [];
    const unmatchedAfter = [...afterGroup];

    for (const beforeFact of beforeGroup) {
      const exactMatchIndex = unmatchedAfter.findIndex(
        (afterFact) =>
          stableJsonStringify(beforeFact.fact) ===
          stableJsonStringify(afterFact.fact),
      );

      if (exactMatchIndex === -1) {
        unmatchedBefore.push(beforeFact);
        continue;
      }

      unmatchedAfter.splice(exactMatchIndex, 1);
    }

    const changedFactCount = Math.min(
      unmatchedBefore.length,
      unmatchedAfter.length,
    );

    for (let index = 0; index < changedFactCount; index += 1) {
      const beforeFact = unmatchedBefore[index];
      const afterFact = unmatchedAfter[index];

      if (beforeFact === undefined || afterFact === undefined) {
        continue;
      }

      changedFacts.push({
        after: afterFact.fact,
        before: beforeFact.fact,
        factId: beforeFact.factId,
        sectionKey: beforeFact.sectionKey,
      });
    }

    for (const beforeFact of unmatchedBefore.slice(changedFactCount)) {
      removedFacts.push(beforeFact);
    }

    for (const afterFact of unmatchedAfter.slice(changedFactCount)) {
      addedFacts.push(afterFact);
    }
  }

  return {
    addedFacts,
    changedFacts,
    removedFacts,
  };
}

function compareSectionStatuses(
  before: CompanyDossier,
  after: CompanyDossier,
): readonly SnapshotSectionStatusChange[] {
  const sectionKeys = [
    ...new Set([
      ...Object.keys(before.sections),
      ...Object.keys(after.sections),
    ]),
  ].sort();
  const changes: SnapshotSectionStatusChange[] = [];

  for (const sectionKey of sectionKeys) {
    const beforeStatus = before.sections[sectionKey]?.status;
    const afterStatus = after.sections[sectionKey]?.status;

    if (beforeStatus === afterStatus) {
      continue;
    }

    const change: {
      afterStatus?: EvidenceStatus;
      beforeStatus?: EvidenceStatus;
      sectionKey: string;
    } = { sectionKey };

    if (beforeStatus !== undefined) {
      change.beforeStatus = beforeStatus;
    }

    if (afterStatus !== undefined) {
      change.afterStatus = afterStatus;
    }

    changes.push(change);
  }

  return changes;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    const items: JsonValue[] = [];

    for (const item of value) {
      const jsonItem = toJsonValue(item);

      if (jsonItem === undefined) {
        return undefined;
      }

      items.push(jsonItem);
    }

    return items;
  }

  if (isJsonObject(value)) {
    const record: Record<string, JsonValue> = {};

    for (const [key, item] of Object.entries(value)) {
      const jsonItem = toJsonValue(item);

      if (jsonItem === undefined) {
        return undefined;
      }

      record[key] = jsonItem;
    }

    return record;
  }

  return undefined;
}

function isIgnoredStructuredPath(path: readonly string[]): boolean {
  if (path.length === 1 && path[0] === "generatedAt") {
    return true;
  }

  return (
    path.length >= 3 &&
    path[0] === "sections" &&
    (path[2] === "facts" || path[2] === "status")
  );
}

function snapshotOtherChange(
  path: readonly string[],
  before: unknown,
  after: unknown,
): SnapshotOtherChange {
  const change: {
    after?: JsonValue;
    before?: JsonValue;
    path: string;
  } = {
    path: path.join("."),
  };

  const stableBefore = toJsonValue(stableJsonValue(before));
  const stableAfter = toJsonValue(stableJsonValue(after));

  if (stableBefore !== undefined) {
    change.before = stableBefore;
  }

  if (stableAfter !== undefined) {
    change.after = stableAfter;
  }

  return change;
}

function collectOtherChanges(
  before: unknown,
  after: unknown,
  path: readonly string[] = [],
): readonly SnapshotOtherChange[] {
  if (isIgnoredStructuredPath(path)) {
    return [];
  }

  if (stableJsonStringify(before) === stableJsonStringify(after)) {
    return [];
  }

  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].sort();

    return keys.flatMap((key) =>
      collectOtherChanges(before[key], after[key], [...path, key]),
    );
  }

  return [snapshotOtherChange(path, before, after)];
}

export function compareCompanyDossiers(
  before: CompanyDossier,
  after: CompanyDossier,
  fileNames: {
    readonly afterFileName?: string;
    readonly beforeFileName?: string;
  } = {},
): DossierSnapshotComparison {
  const beforeDossier = parseDossierForSnapshot(before);
  const afterDossier = parseDossierForSnapshot(after);
  const factComparison = compareFacts(beforeDossier, afterDossier);
  const sectionStatusChanges = compareSectionStatuses(
    beforeDossier,
    afterDossier,
  );
  const otherChanges = collectOtherChanges(beforeDossier, afterDossier);
  const hasChanges =
    factComparison.addedFacts.length > 0 ||
    factComparison.changedFacts.length > 0 ||
    factComparison.removedFacts.length > 0 ||
    sectionStatusChanges.length > 0 ||
    otherChanges.length > 0;

  return {
    ...factComparison,
    afterFileName: fileNames.afterFileName ?? "",
    beforeFileName: fileNames.beforeFileName ?? "",
    hasChanges,
    otherChanges,
    sectionStatusChanges,
  };
}

export async function compareDossierSnapshots(
  options: CompareDossierSnapshotsOptions,
): Promise<DossierSnapshotComparison> {
  const before = await readDossierSnapshot({
    fileName: options.beforeFileName,
    snapshotDir: options.snapshotDir,
  });
  const after = await readDossierSnapshot({
    fileName: options.afterFileName,
    snapshotDir: options.snapshotDir,
  });

  return compareCompanyDossiers(before.dossier, after.dossier, {
    afterFileName: after.fileName,
    beforeFileName: before.fileName,
  });
}
