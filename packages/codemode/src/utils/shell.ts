import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { ACTION_MEMORY_BYTES, OutputFileWriter } from "./output-files.js";
import { cutText, isOutputBytes, MIN_OUTPUT_LIMIT } from "./output-limit.js";
import { MAX_TIMEOUT_MS } from "./timers.js";

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
  /**
   * Added to the host process's environment, which the command inherits. A
   * name set to `undefined` is left out of it.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** After this long the command's process group is killed and the call rejects. Default: no limit. */
  timeoutMs?: number;
  /** Aborting kills the command's process group and rejects the call. */
  signal?: AbortSignal;
  /**
   * How much output is held in memory and returned. Past it the result
   * carries the output's last lines, and all of it is in a file. Default:
   * `ACTION_MEMORY_BYTES`, 8 MiB.
   */
  maxOutputBytes?: number;
  /** The start of the name of the file that keeps output past `maxOutputBytes`. Default: `codemode-shell`. */
  outputFilePrefix?: string;
  /** Where that file is written: an action passes `ctx.outputDir`. Default: the system's temporary directory. */
  outputDir?: string;
}

export interface ShellResult {
  /**
   * stdout and stderr together, each in the order it was written. They are
   * two pipes, so a line of one may land before an earlier line of the other.
   */
  output: string;
  /** The shell's exit code. A shell ended by a signal has 128 plus the signal's number. */
  exitCode: number;
  /**
   * Whether `output` is only the end of what the command wrote, followed by
   * a line that says which lines it shows and where the rest is.
   */
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

/** How long output may stay quiet, once the shell has exited, before the call ends. */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * What a command wrote, within a bound: everything while it fits, then its
 * end in memory and the whole of it in a file.
 */
class ShellOutput {
  /** The end of the output: all of it until it passes the bound, then that much and a chunk. */
  private kept: Buffer[] = [];
  private keptBytes = 0;
  /** Whether `kept` starts where a line starts. */
  private keptFromLineStart = true;
  private total = 0;
  private lineBreaks = 0;
  private lastByte: number | undefined;
  /** Everything written, from the moment it passes the bound. */
  private file: OutputFileWriter | undefined;

  constructor(
    private readonly maxBytes: number,
    private readonly prefix: string,
    private readonly dir: string | undefined,
  ) {}

  private get lines(): number {
    return (
      this.lineBreaks +
      (this.lastByte === undefined || this.lastByte === 0x0a ? 0 : 1)
    );
  }

  /**
   * Take more output. Answers false when the file is behind: the caller
   * stops reading until `drained()`, so a command that writes faster than
   * the disk takes is slowed instead of held in memory.
   */
  append(chunk: Buffer): boolean {
    if (!chunk.length) return true;
    this.total += chunk.length;
    for (
      let at = chunk.indexOf(0x0a);
      at !== -1;
      at = chunk.indexOf(0x0a, at + 1)
    )
      this.lineBreaks++;
    this.lastByte = chunk[chunk.length - 1];
    if (!this.file && this.total > this.maxBytes) {
      this.file = new OutputFileWriter(this.prefix, ".log", this.dir);
      for (const earlier of this.kept) this.file.write(earlier);
    }
    const keepReading = this.file?.write(chunk) ?? true;
    this.kept.push(chunk);
    this.keptBytes += chunk.length;
    // Whole chunks are dropped while what stays is still as much as is
    // handed back. The file starts at the bound, so it holds everything
    // before a chunk is dropped.
    while (
      this.kept.length > 1 &&
      this.keptBytes - this.kept[0].length >= this.maxBytes
    ) {
      const dropped = this.kept.shift() as Buffer;
      this.keptBytes -= dropped.length;
      this.keptFromLineStart = dropped[dropped.length - 1] === 0x0a;
    }
    return keepReading;
  }

  /** Resolves when the file has caught up, or has failed. */
  drained(): Promise<void> {
    return this.file?.drained() ?? Promise.resolve();
  }

  /** The output as text, once nothing more is appended. */
  async finish(): Promise<{ text: string; truncated: boolean; path?: string }> {
    const path = await this.file?.close();
    let end = Buffer.concat(this.kept);
    if (this.total <= this.maxBytes)
      return { text: end.toString("utf8"), truncated: false };
    // What is kept starts between characters and then at a line, unless
    // that leaves nothing: the output is then the end of one long line.
    let start = 0;
    while (start < end.length && (end[start] & 0xc0) === 0x80) start++;
    end = end.subarray(start);
    const whole = end.toString("utf8");
    const fromLine = this.keptFromLineStart
      ? whole
      : whole.slice(whole.indexOf("\n") + 1);
    return {
      text: cutText(
        fromLine.trim() ? fromLine : whole,
        { lines: Number.POSITIVE_INFINITY, bytes: this.maxBytes },
        {
          keep: "last",
          path,
          total: { lines: this.lines, bytes: this.total },
        },
      ).text,
      truncated: true,
      ...(path ? { path } : {}),
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

/** Process groups in flight, each led by a command this process started. */
const running = new Set<number>();
/** The signals that end a process by default. */
const ENDING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function endRunning(): void {
  if (!running.size) return;
  if (process.platform !== "win32") {
    for (const pid of running) killProcessTree(pid);
  } else {
    // Waited for: once this process is gone, taskkill no longer finds what
    // the commands started.
    spawnSync(
      taskkill(),
      ["/F", "/T", ...[...running].flatMap((pid) => ["/PID", String(pid)])],
      { stdio: "ignore", timeout: 2000, windowsHide: true },
    );
  }
  running.clear();
}

function onEndingSignal(signal: NodeJS.Signals): void {
  endRunning();
  stopWatchingHost();
  // Listening took the signal's default away. With no listener of the
  // host's own left, the signal ends the process as it would have.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function stopWatchingHost(): void {
  process.off("exit", endRunning);
  for (const signal of ENDING_SIGNALS) process.off(signal, onEndingSignal);
}

/**
 * End `pid`'s process group with this process: on exit and on the signals
 * that end it. A group of its own does not get the terminal's Ctrl-C, so
 * nothing else would. Answers how to stop, once the command has ended. The
 * process is watched only while a command is in flight.
 */
export function endWithHost(pid: number): () => void {
  if (!running.size) {
    process.on("exit", endRunning);
    for (const signal of ENDING_SIGNALS) process.on(signal, onEndingSignal);
  }
  running.add(pid);
  return () => {
    running.delete(pid);
    if (!running.size) stopWatchingHost();
  };
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
  const maxOutputBytes = options.maxOutputBytes ?? ACTION_MEMORY_BYTES;
  if (!isOutputBytes(maxOutputBytes))
    throw new RangeError(
      `Invalid maxOutputBytes: a whole number of bytes, at least ${MIN_OUTPUT_LIMIT.bytes}`,
    );
  if (signal?.aborted) throw new ShellError("aborted", "Command aborted");
  if (options.cwd !== undefined && !existsSync(options.cwd))
    throw new ShellError(
      "spawn_failed",
      `Working directory does not exist: ${options.cwd}`,
    );

  const output = new ShellOutput(
    maxOutputBytes,
    options.outputFilePrefix ?? "codemode-shell",
    options.outputDir,
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
  const stopWatching = pid === undefined ? undefined : endWithHost(pid);
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
    stopWatching?.();
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
