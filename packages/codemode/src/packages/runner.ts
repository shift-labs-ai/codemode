import { spawn } from "node:child_process";
import { endProcessTree, endWithHost } from "../utils/process-tree.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Milliseconds before the command is ended. One that outlives them never answers code 0. */
  timeoutMs?: number;
  /** The command's whole environment. Default: the host process's. */
  env?: Record<string, string>;
}

/**
 * Runs the programs the package manager and the binary manager start: npm,
 * pnpm, bun and git, and tar, unzip and a binary's own check. Always an
 * argument list, never a shell string. A host replaces it to run them in a
 * sandbox or another process, or to refuse them (an offline host).
 */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
}

/** How much of what a command wrote is kept, for an error to quote. */
const KEPT_OUTPUT_CHARS = 1024 * 1024;

/** The end of what a failed command wrote, for an error to quote. */
export function failureDetail(result: CommandResult): string {
  return (result.stderr || result.stdout)
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n");
}

/** The package managers that are `.cmd` shims on Windows. */
const WINDOWS_SHIMS = new Set(["npm", "pnpm", "bun"]);

/**
 * One argument for cmd.exe, quoted. Inside double quotes cmd still expands
 * `%VAR%` and ends the quote at `"`, so an argument carrying either (or a
 * line break) is refused rather than escaped.
 */
export function quoteForCmd(arg: string): string {
  if (/[%"\r\n]/.test(arg))
    throw new Error(`Argument cannot be passed through cmd.exe: ${arg}`);
  return /^[A-Za-z0-9_\-./:@=~+]+$/.test(arg) ? arg : `"${arg}"`;
}

/**
 * The default runner: `node:child_process` `spawn` with an argument list and
 * no shell. On Windows npm, pnpm and bun are `.cmd` shims that only a shell
 * can start, so those go through cmd.exe with every argument quoted by
 * `quoteForCmd`. Every other program is started directly.
 *
 * The command leads a process group of its own. On timeout and abort it is
 * ended as `endProcessTree` does: npm and git start processes that would
 * otherwise outlive them.
 */
export const nodeCommandRunner: CommandRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const { signal } = options;
      if (signal?.aborted) return reject(signal.reason);
      const viaCmd = process.platform === "win32" && WINDOWS_SHIMS.has(command);
      const child = viaCmd
        ? spawn([command, ...args].map(quoteForCmd).join(" "), {
            cwd: options.cwd,
            env: options.env,
            shell: true,
            windowsHide: true,
          })
        : spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false,
            detached: process.platform !== "win32",
            windowsHide: true,
          });
      const stopWatching = endWithHost(child);
      let outlived = false;
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              outlived = child.exitCode === null && child.signalCode === null;
              void endProcessTree(child);
            }, options.timeoutMs);
      // Rejected once the command and what it started are down.
      const onAbort = () =>
        void endProcessTree(child).then(() =>
          settle(() => reject(signal?.reason)),
        );
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        stopWatching();
        finish();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < KEPT_OUTPUT_CHARS) stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < KEPT_OUTPUT_CHARS) stderr += chunk.toString();
      });
      child.on("error", (error) => settle(() => reject(error)));
      child.on("close", (code, ended) => {
        // An aborted command settles from `onAbort`.
        if (signal?.aborted) return;
        // A command asked to end may exit cleanly: it still did not finish.
        const failed = outlived ? code || 128 : code;
        settle(() =>
          resolve({ code: failed ?? (ended ? 128 : 1), stdout, stderr }),
        );
      });
    });
  },
};
