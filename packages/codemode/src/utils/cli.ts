import { execFileSync } from "node:child_process";

export type OutputParser = "json" | "jsonlines" | "text";

export interface ExecOptions {
  parser?: OutputParser;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  rows: Record<string, unknown>[];
}

export function syncExec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): ExecResult {
  const stdout = execFileSync(command, args, {
    encoding: "utf-8",
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    timeout: options.timeout,
    maxBuffer: 100 * 1024 * 1024,
  }).trim();

  const parser = options.parser ?? "text";
  let rows: Record<string, unknown>[] = [];

  if (parser === "json" && stdout) {
    const parsed = JSON.parse(stdout);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } else if (parser === "jsonlines" && stdout) {
    rows = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  return { stdout, rows };
}

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
export { MAX_TIMEOUT_MS } from "./timers.js";
