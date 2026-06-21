#!/usr/bin/env node

import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  await copyFile(
    join(root, ".env.example"),
    join(root, ".env"),
    constants.COPYFILE_EXCL,
  );
  process.stdout.write("Created .env from .env.example.\n");
} catch (error) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  ) {
    process.stderr.write(".env already exists; leaving it unchanged.\n");
    process.exitCode = 2;
  } else {
    throw error;
  }
}
