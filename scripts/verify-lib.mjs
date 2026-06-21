#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const isWindows = process.platform === "win32";

export function npmCommand() {
  return isWindows ? "npm.cmd" : "npm";
}

export function log(message) {
  process.stdout.write(`==> ${message}\n`);
}

export function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

export async function run(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    input,
    stdio = "pipe",
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio:
        stdio === "inherit"
          ? input === undefined
            ? "inherit"
            : ["pipe", "inherit", "inherit"]
          : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];

    if (stdio !== "inherit") {
      child.stdout?.on("data", (chunk) => {
        stdout.push(Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk) => {
        stderr.push(Buffer.from(chunk));
      });
    }

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });

    if (input !== undefined) {
      child.stdin?.end(input);
    } else if (stdio !== "inherit") {
      child.stdin?.end();
    }
  });
}

export async function runOrFail(label, command, args, options = {}) {
  log(label);

  const result = await run(command, args, {
    ...options,
    stdio: options.stdio ?? "inherit",
  });

  if (result.code !== 0) {
    fail(`${label} failed with exit code ${String(result.code)}.`);
  }

  return result;
}

export async function commandExists(command) {
  try {
    const result = await run(command, ["--version"], {
      stdio: "pipe",
    });

    return result.code === 0;
  } catch {
    return false;
  }
}

export async function gitRoot(cwd = process.cwd()) {
  const result = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });

  if (result.code !== 0) {
    fail(result.stderr.trim() || "Unable to resolve Git repository root.");
  }

  return result.stdout.trim();
}

export async function gitOutput(args, cwd) {
  const result = await run("git", args, { cwd });

  if (result.code !== 0) {
    fail(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }

  return result.stdout;
}

export function normaliseGitPath(path) {
  return path.replaceAll("\\", "/");
}

export async function collectFiles(root, relativePath) {
  const absolutePath = join(root, relativePath);
  const metadata = await stat(absolutePath).catch(() => undefined);

  if (metadata === undefined) {
    return [];
  }

  if (metadata.isFile()) {
    return [relativePath];
  }

  if (!metadata.isDirectory()) {
    return [];
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const childRelativePath = `${relativePath}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, childRelativePath)));
    } else if (entry.isFile()) {
      files.push(childRelativePath);
    }
  }

  return files;
}

export async function readRepositoryText(root, relativePath) {
  return readFile(join(root, relativePath), "utf8");
}
