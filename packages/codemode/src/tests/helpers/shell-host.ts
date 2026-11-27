// A host process for `shell.test.ts`: it starts a command that outlives it
// through `runShell`, then exits (`exit`) or waits to be interrupted
// (`wait`). The command writes its pid to the file named first. A third
// argument is the command, in place of one that sleeps.
import { existsSync } from "node:fs";
import { runShell } from "../../utils/shell.js";

const [pidFile, ending, script = `sleep 30 & echo $! > ${pidFile}; wait`] =
  process.argv.slice(2);
void runShell({ program: "/bin/sh", args: ["-c"] }, script).catch(() => {});
while (!existsSync(pidFile))
  await new Promise((resolve) => setTimeout(resolve, 10));
// The pid is written just after the file appears.
await new Promise((resolve) => setTimeout(resolve, 100));
if (ending === "exit") process.exit(0);
