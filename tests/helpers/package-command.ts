import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

export function packageCommand(command: "npm" | "npx"): string {
  return isWindows ? `${command}.cmd` : command;
}

export function packageCommandOptions(
  options: ExecFileOptions = {},
): ExecFileOptions {
  return {
    ...options,
    shell: isWindows,
  };
}

export async function execPackageCommand(
  command: "npm" | "npx",
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const result = await execFileAsync(
    packageCommand(command),
    [...args],
    packageCommandOptions(options),
  );

  return {
    stderr: String(result.stderr),
    stdout: String(result.stdout),
  };
}
