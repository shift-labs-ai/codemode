import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How long a command has to end, once it is asked to, before it is killed. */
export const END_GRACE_MS = 5_000;
/** How often the processes a command started are looked at, while it has that long. */
const ALIVE_POLL_MS = 25;
/** How long one look at the process table may take. */
const SCAN_TIMEOUT_MS = 1_000;

function taskkill(): string {
  // The System32 program, so that ending a command does not depend on PATH.
  return join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signal(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(pid, name);
  } catch {
    // Already gone, or not this account's to signal.
    return false;
  }
}

/**
 * Linux: who started whom, read once from `/proc`. Answers the children of
 * a set of processes.
 */
function procChildren(): (parents: number[]) => number[] {
  const children = new Map<number, number[]>();
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    // No /proc to read: nothing is found, and the group is still signalled.
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      // `pid (comm) state ppid …`: the name may hold spaces and brackets,
      // so the fields are read from after its last bracket.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parent = Number(
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1],
      );
      if (!Number.isInteger(parent)) continue;
      const siblings = children.get(parent);
      if (siblings) siblings.push(pid);
      else children.set(parent, [pid]);
    } catch {
      // The process ended while the table was read.
    }
  }
  return (parents) => parents.flatMap((pid) => children.get(pid) ?? []);
}

/**
 * macOS: the children of a set of processes, by `pgrep`. `ps` is setuid,
 * and macOS does not start it under a sandbox profile.
 */
function pgrepChildren(parents: number[]): number[] {
  const scan = spawnSync("/usr/bin/pgrep", ["-P", parents.join(",")], {
    encoding: "utf8",
    timeout: SCAN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // A scan that fails finds nothing: what was found before it still counts.
  if (scan.status !== 0) return [];
  return scan.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Every process `pid` started, and those started in turn, by who their
 * parent is. That finds a process that left the command's group for a
 * session of its own, as long as its parent is alive: a process whose
 * parent has ended belongs to no one. Empty where the process table cannot
 * be read, which is everywhere but Linux and macOS.
 */
function descendants(pid: number): number[] {
  const childrenOf =
    process.platform === "linux"
      ? procChildren()
      : process.platform === "darwin"
        ? pgrepChildren
        : () => [];
  const found: number[] = [];
  const seen = new Set([pid]);
  let level = [pid];
  while (level.length) {
    level = childrenOf(level).filter((child) => !seen.has(child));
    for (const child of level) {
      seen.add(child);
      found.push(child);
    }
  }
  return found;
}

/** Signal the process group `pid` leads, or `pid` alone when it leads none. */
function signalGroup(pid: number, name: NodeJS.Signals): void {
  // macOS signals a group's members one at a time, so a shell can see its
  // child end and start the next command of `a; b` before its own signal
  // arrives. A stopped group starts nothing: SIGKILL ends it as it is, and
  // any other signal is taken when the group continues.
  const stopped = process.platform === "darwin" && signal(-pid, "SIGSTOP");
  if (!signal(-pid, name)) signal(pid, name);
  if (stopped && name !== "SIGKILL") signal(-pid, "SIGCONT");
}

/** Signal each process alone: never init, never this process. */
function signalEach(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) if (pid > 1 && pid !== process.pid) signal(pid, name);
}

/**
 * Kill a process and everything it started, at once: its process group, and
 * what left the group. `pid` is a process still running. Once it has ended,
 * its id may be another process's.
 */
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
  // Found before the signal: a process whose parent has ended is not found.
  const started = descendants(pid);
  signalGroup(pid, "SIGKILL");
  signalEach(started, "SIGKILL");
}

/** Commands being ended, so that asking twice is one ending. */
const endings = new WeakMap<ChildProcess, Promise<void>>();

async function end(child: ChildProcess, pid: number): Promise<void> {
  if (process.platform === "win32") return killProcessTree(pid);
  const started = descendants(pid);
  signalGroup(pid, "SIGTERM");
  signalEach(started, "SIGTERM");
  const gone = await new Promise<boolean>((resolve) => {
    const done = (all: boolean) => {
      clearTimeout(limit);
      clearInterval(poll);
      child.off("exit", look);
      resolve(all);
    };
    const look = () => {
      if (hasExited(child) && !started.some((other) => signal(other, 0)))
        done(true);
    };
    const limit = setTimeout(() => done(false), END_GRACE_MS);
    const poll = setInterval(look, ALIVE_POLL_MS);
    child.once("exit", look);
  });
  if (gone) return;
  if (!hasExited(child)) {
    for (const later of descendants(pid))
      if (!started.includes(later)) started.push(later);
    signalGroup(pid, "SIGKILL");
  }
  signalEach(started, "SIGKILL");
}

/**
 * End a command and everything it started, and resolve when that is done.
 * `child` leads a process group of its own.
 *
 * The group and each process the command started are asked to end with
 * SIGTERM, so they can clean up. What is still there after `END_GRACE_MS`
 * is killed. On Windows the tree is killed at once.
 *
 * A command that has exited is not signalled: its group's id may be
 * another's by now. Its output is closed, which ends a wait for it. What it
 * left running in the background stays, as it does after a command that
 * returns.
 */
export function endProcessTree(child: ChildProcess): Promise<void> {
  const { pid } = child;
  let ending = endings.get(child);
  if (hasExited(child)) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  } else if (!ending && pid !== undefined) {
    ending = end(child, pid);
    endings.set(child, ending);
  }
  return ending ?? Promise.resolve();
}

/** Commands in flight, each leading a process group. */
const running = new Set<ChildProcess>();
/** The signals that end a process by default. */
const ENDING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** Whether this process's exit and those signals are listened for. */
let watching = false;
/** Whether one of the signals has arrived and the commands are being ended. */
let interrupted = false;

/** Kill every command in flight at once, without waiting: all a process that is exiting can do. */
function killRunning(): void {
  const pids = [...running].flatMap((child) =>
    child.pid === undefined || hasExited(child) ? [] : [child.pid],
  );
  running.clear();
  if (!pids.length) return;
  if (process.platform !== "win32") {
    for (const pid of pids) killProcessTree(pid);
    return;
  }
  // Waited for: once this process is gone, taskkill no longer finds what
  // the commands started.
  spawnSync(
    taskkill(),
    ["/F", "/T", ...pids.flatMap((pid) => ["/PID", String(pid)])],
    { stdio: "ignore", timeout: 2000, windowsHide: true },
  );
}

/**
 * Kill what is still in flight, and let the signal end this process, as it
 * would have with nothing listening.
 */
function passOn(name: NodeJS.Signals): void {
  killRunning();
  stopWatchingHost();
  // Listening took the signal's default away. With no listener of the
  // host's own left, the signal ends the process as it would have.
  if (process.listenerCount(name) === 0) process.kill(process.pid, name);
}

function onEndingSignal(name: NodeJS.Signals): void {
  if (interrupted) {
    // Asked again: nothing is waited for.
    passOn(name);
    return;
  }
  interrupted = true;
  void Promise.all([...running].map(endProcessTree)).then(() => {
    if (interrupted) passOn(name);
  });
}

function stopWatchingHost(): void {
  if (!watching) return;
  watching = false;
  interrupted = false;
  process.off("exit", killRunning);
  for (const name of ENDING_SIGNALS) process.off(name, onEndingSignal);
}

/**
 * End `child` with this process: killed when it exits, and ended as
 * `endProcessTree` does on the signals that end it, or killed at once when
 * such a signal arrives a second time. A group of its own does not get the
 * terminal's Ctrl-C, so nothing else would. Answers how to stop, once the
 * command has ended. The process is watched only while a command is in
 * flight.
 */
export function endWithHost(child: ChildProcess): () => void {
  if (!watching) {
    watching = true;
    process.on("exit", killRunning);
    for (const name of ENDING_SIGNALS) process.on(name, onEndingSignal);
  }
  running.add(child);
  return () => {
    if (running.delete(child) && !running.size && !interrupted)
      stopWatchingHost();
  };
}
