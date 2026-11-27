import { execFileSync } from "node:child_process";

/** Where a command is on `PATH`, when it is there. */
export function commandPath(name: string): string | undefined {
  try {
    const found = execFileSync(
      process.platform === "win32" ? "where" : "which",
      [name],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
    return found.split(/\r?\n/)[0].trim() || undefined;
  } catch {
    return undefined;
  }
}

export function commandExists(name: string): boolean {
  return commandPath(name) !== undefined;
}

export { packageBinaries } from "../binaries/declaration.js";
export {
  type CommandOutput,
  type RunCommandOptions,
  runBinary,
  runCommand,
} from "./command.js";
export { packageVersion } from "./package-version.js";
export {
  isShellError,
  killProcessTree,
  type RunShellOptions,
  runShell,
  ShellError,
  type ShellErrorCode,
  type ShellProgram,
  type ShellResult,
} from "./shell.js";
export {
  pathExists,
  type ShellRunActionOptions,
  shellConnectionSchema,
  shellRunAction,
} from "./shell-action.js";
export type { SpawnCall, SpawnCommand, SpawnHook } from "./spawn.js";
export { MAX_TIMEOUT_MS } from "./timers.js";
