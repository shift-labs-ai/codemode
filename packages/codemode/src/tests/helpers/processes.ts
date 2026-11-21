// Watching processes that a test's subject starts: a script writes a pid to
// a file, and the test waits for the pid, then for the process to end.
import { existsSync, readFileSync } from "node:fs";

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether `pid` ends within `ms`. */
export async function ends(pid: number, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** The pid a script wrote to `file`, once it is there. */
export async function pidIn(file: string): Promise<number> {
  for (let tries = 0; tries < 200; tries++) {
    if (existsSync(file) && readFileSync(file, "utf8").trim())
      return Number(readFileSync(file, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no pid in ${file}`);
}
