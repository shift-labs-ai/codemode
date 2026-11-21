import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

/** How a shell program takes a script. */
export interface ShellProgram {
  program: string;
  /** The arguments before the script, such as `["-c"]`. */
  args: readonly string[];
  /** Send the script on stdin instead of as the last argument. */
  scriptOnStdin?: boolean;
}

export interface RunShellOptions {
  /** Working directory. Default: the host process's. */
  cwd?: string;
  /** Added to the host process's environment, which the command inherits. */
  env?: Readonly<Record<string, string | undefined>>;
  /** After this long the command's process group is killed and the call rejects. Default: no limit. */
  timeoutMs?: number;
  /** Aborting kills the command's process group and rejects the call. */
  signal?: AbortSignal;
  /** How much output the result carries. Default: 1 MiB. */
  maxOutputBytes?: number;
  /** The start of the name of the file that keeps output past the limit. Default: `codemode-shell`. */
  outputFilePrefix?: string;
}

export interface ShellResult {
  /**
   * stdout and stderr together, each in the order it was written. They are
   * two pipes, so a line of one may land before an earlier line of the other.
   */
  output: string;
  /** The shell's exit code. A shell ended by a signal has 128 plus the signal's number. */
  exitCode: number;
  /** Whether `output` leaves out the middle of what the command wrote. */
  truncated: boolean;
  /** The file holding everything the command wrote, when `output` does not. */
  fullOutputPath?: string;
  wallTimeMs: number;
}

export type ShellErrorCode = "spawn_failed" | "timed_out" | "aborted";

/** A command that did not run to its own end. `output` is what it wrote until then. */
export class ShellError extends Error {
  readonly code: ShellErrorCode;
  readonly output: string;
  readonly fullOutputPath?: string;

  constructor(
    code: ShellErrorCode,
    message: string,
    output: { text: string; path?: string } = { text: "" },
  ) {
    super(output.text ? `${output.text.trimEnd()}\n\n${message}` : message);
    this.name = "ShellError";
    this.code = code;
    this.output = output.text;
    if (output.path !== undefined) this.fullOutputPath = output.path;
  }
}

/** Recognised by shape, so an error from another copy of this module counts too. */
export function isShellError(error: unknown): error is ShellError {
  return (
    error instanceof Error &&
    error.name === "ShellError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** The longest delay a timer takes. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** How long output may stay quiet, once the shell has exited, before the call ends. */
const EXIT_STDIO_GRACE_MS = 100;
/** Output goes to its file in blocks of this size, not a write per chunk read. */
const SPILL_BLOCK_BYTES = 64 * 1024;

/**
 * What a command wrote, within a bound: everything while it fits, then its
 * first and last halves in memory and the whole of it in a file.
 */
class ShellOutput {
  private readonly half: number;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;
  private path: string | undefined;
  private file: WriteStream | undefined;
  /** What the file has not been handed yet: it is written in blocks. */
  private block: Buffer[] = [];
  private blockBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly prefix: string,
  ) {
    this.half = Math.floor(maxBytes / 2);
  }

  /**
   * Take more output. Answers false when the file is behind: the caller
   * stops reading until `drained()`, so a command that writes faster than
   * the disk takes is slowed instead of held in memory.
   */
  append(chunk: Buffer): boolean {
    if (!chunk.length) return true;
    this.total += chunk.length;
    let keepReading = true;
    if (this.file) keepReading = this.write(chunk);
    else if (this.total > this.maxBytes) this.spill(chunk);
    if (this.headBytes < this.half) {
      const part = chunk.subarray(0, this.half - this.headBytes);
      this.head.push(part);
      this.headBytes += part.length;
      chunk = chunk.subarray(part.length);
      if (!chunk.length) return keepReading;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    // Whole chunks are dropped while what stays still covers the tail.
    while (
      this.tail.length > 1 &&
      this.tailBytes - this.tail[0].length >= this.maxBytes - this.half
    )
      this.tailBytes -= (this.tail.shift() as Buffer).length;
    return keepReading;
  }

  /** Resolves when the file has caught up. */
  drained(): Promise<void> {
    const file = this.file;
    return file?.writableNeedDrain
      ? new Promise((resolve) => {
          const done = () => {
            file.off("drain", done);
            file.off("error", done);
            resolve();
          };
          file.once("drain", done);
          file.once("error", done);
        })
      : Promise.resolve();
  }

  private write(chunk: Buffer): boolean {
    this.block.push(chunk);
    this.blockBytes += chunk.length;
    return this.blockBytes < SPILL_BLOCK_BYTES || this.flush();
  }

  private flush(): boolean {
    if (!this.file || !this.blockBytes) return true;
    const block = Buffer.concat(this.block);
    this.block = [];
    this.blockBytes = 0;
    return this.file.write(block);
  }

  /** Start the file with everything so far; `latest` is its last part. */
  private spill(latest: Buffer): void {
    this.path = join(
      tmpdir(),
      `${this.prefix}-${randomBytes(8).toString("hex")}.log`,
    );
    // Output can carry private data: only the user reads it, and `wx` never
    // follows a link someone else placed at the path.
    this.file = createWriteStream(this.path, { mode: 0o600, flags: "wx" });
    this.file.on("error", () => {});
    this.block = [...this.head, ...this.tail, latest];
    this.blockBytes = this.total;
    this.flush();
  }

  /** The output as text, once nothing more is appended. */
  async finish(): Promise<{ text: string; truncated: boolean; path?: string }> {
    if (this.file) {
      const file = this.file;
      this.flush();
      await new Promise<void>((resolve) => file.end(resolve));
    }
    const head = Buffer.concat(this.head);
    if (this.total <= this.maxBytes)
      return {
        text: Buffer.concat([head, ...this.tail]).toString("utf8"),
        truncated: false,
      };
    const kept = this.maxBytes - this.half;
    let tail = Buffer.concat(this.tail);
    tail = tail.subarray(Math.max(0, tail.length - kept));
    // Cut at character boundaries: a streaming decode holds back an
    // unfinished sequence, and the tail skips the rest of one.
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    const omitted = this.total - head.length - tail.length;
    return {
      text: `${new TextDecoder().decode(head, { stream: true })}\n\n[... ${omitted} bytes omitted ...]\n\n${tail.subarray(start).toString("utf8")}`,
      truncated: true,
      ...(this.path === undefined ? {} : { path: this.path }),
    };
  }
}

function taskkill(): string {
  // The System32 program, so that ending a command does not depend on PATH.
  return join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
}

/** End a process and everything it started. */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn(taskkill(), ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      }).once("error", () => {});
    } catch {
      // Nothing to end, or no taskkill to end it with.
    }
    return;
  }
  if (process.platform === "darwin") {
    // macOS signals a group's members one at a time, so a shell can see its
    // killed child end and start the next command of `a; b` before its own
    // signal arrives. Stopping the group first narrows that.
    try {
      process.kill(-pid, "SIGSTOP");
    } catch {
      // The kill is still tried.
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Commands in flight, ended with the host process: each leads its own process group. */
const running = new Set<number>();
let endsWithHost = false;

function endWithHost(pid: number): void {
  running.add(pid);
  if (endsWithHost) return;
  endsWithHost = true;
  process.once("exit", () => {
    if (!running.size) return;
    if (process.platform !== "win32") {
      for (const each of running) killProcessTree(each);
      return;
    }
    // Waited for: once this process is gone, taskkill no longer finds what
    // the shells started.
    spawnSync(
      taskkill(),
      ["/F", "/T", ...[...running].flatMap((each) => ["/PID", String(each)])],
      { stdio: "ignore", timeout: 2000, windowsHide: true },
    );
  });
}

/**
 * The exit code of a child, once it has ended and its output has been read.
 * A command may leave a background process holding its output pipes open,
 * so the wait ends when the pipes close or, after the shell's exit, when
 * they have been quiet for a moment. Output still arriving restarts that
 * moment, so none is cut off, and a moment in which `reading()` is false
 * does not count.
 */
function ended(
  child: ChildProcess,
  reading: () => boolean,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let code: number | null = null;
    let quiet: NodeJS.Timeout | undefined;
    let open = [child.stdout, child.stderr].filter((stream) => stream).length;

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(quiet);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      finish();
    };
    const done = () =>
      settle(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(code);
      });
    const rearm = () => {
      clearTimeout(quiet);
      // Pipes the caller has paused are not quiet: their output is waiting.
      quiet = setTimeout(
        () => (reading() ? done() : rearm()),
        EXIT_STDIO_GRACE_MS,
      );
    };
    const onData = () => {
      if (exited) rearm();
    };
    const onEnd = () => {
      open--;
      if (exited && open === 0) done();
    };

    child.stdout?.once("end", onEnd);
    child.stderr?.once("end", onEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (exitCode) => {
      exited = true;
      code = exitCode;
      if (open === 0) done();
      else rearm();
    });
    child.once("close", (exitCode) => {
      code = exitCode ?? code;
      done();
    });
  });
}

/**
 * Run a script through a shell program and answer what it wrote and how it
 * ended. A script that exits with a failure is a result, with its exit
 * code; one that could not start, outlived `timeoutMs` or was aborted is a
 * `ShellError`.
 *
 * Every call is a new process in a process group of its own. The group is
 * killed on timeout and abort, so what the script started ends with it.
 */
export async function runShell(
  shell: ShellProgram,
  script: string,
  options: RunShellOptions = {},
): Promise<ShellResult> {
  const { timeoutMs, signal } = options;
  if (
    timeoutMs !== undefined &&
    !(
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= MAX_TIMEOUT_MS
    )
  )
    throw new RangeError(
      `Invalid timeout: a number of milliseconds above 0 and at most ${MAX_TIMEOUT_MS}`,
    );
  if (signal?.aborted) throw new ShellError("aborted", "Command aborted");
  if (options.cwd !== undefined && !existsSync(options.cwd))
    throw new ShellError(
      "spawn_failed",
      `Working directory does not exist: ${options.cwd}`,
    );

  const output = new ShellOutput(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    options.outputFilePrefix ?? "codemode-shell",
  );
  const started = performance.now();
  const child = spawn(
    shell.program,
    shell.scriptOnStdin ? [...shell.args] : [...shell.args, script],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      stdio: [shell.scriptOnStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (shell.scriptOnStdin) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(script);
  }
  const { pid } = child;
  if (pid !== undefined) endWithHost(pid);
  const kill = () => {
    if (pid !== undefined) killProcessTree(pid);
  };

  let shellExitedAfterMs: number | undefined;
  let timedOut: { shellExitedAfterMs: number | undefined } | undefined;
  child.once("exit", () => {
    shellExitedAfterMs = performance.now() - started;
  });
  let reading = true;
  const take = (chunk: Buffer) => {
    if (output.append(chunk) || !reading) return;
    reading = false;
    child.stdout?.pause();
    child.stderr?.pause();
    void output.drained().then(() => {
      reading = true;
      child.stdout?.resume();
      child.stderr?.resume();
    });
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = { shellExitedAfterMs };
          // Also when the shell has exited: the group kill reaches what it
          // left writing to the pipes.
          kill();
        }, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });

  let code: number | null;
  try {
    code = await ended(child, () => reading);
  } catch (error) {
    await output.finish();
    throw new ShellError(
      "spawn_failed",
      `Could not start ${shell.program}: ${(error as Error).message}`,
    );
  } finally {
    if (pid !== undefined) running.delete(pid);
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }

  const written = await output.finish();
  if (signal?.aborted)
    throw new ShellError("aborted", "Command aborted", written);
  // A shell ended by a signal has no exit code. The shell convention keeps
  // it from reading as success.
  const exitCode =
    code ??
    (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1);
  if (timedOut) {
    const seconds = (ms: number) => Math.round(ms / 100) / 10;
    throw new ShellError(
      "timed_out",
      timedOut.shellExitedAfterMs === undefined
        ? `Command timed out after ${seconds(timeoutMs as number)} seconds`
        : `Command timed out after ${seconds(timeoutMs as number)} seconds. The shell exited with code ${exitCode} after ${seconds(timedOut.shellExitedAfterMs)} seconds, but background processes it started kept writing output until the timeout.`,
      written,
    );
  }
  return {
    output: written.text,
    exitCode,
    truncated: written.truncated,
    ...(written.path === undefined ? {} : { fullOutputPath: written.path }),
    wallTimeMs: Math.round(performance.now() - started),
  };
}
