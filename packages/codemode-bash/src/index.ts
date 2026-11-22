/**
 * Bash for codemode: one action that runs a script on the machine codemode
 * runs on and answers what it wrote and how it ended.
 *
 *   const { output, exitCode } = await bash.run({ command: "git status --short" })
 *
 * Every call is a new process, so `cd` and variables do not carry from one
 * call to the next. The command ends with the run that started it.
 */

import { win32 } from "node:path";
import type { CodemodePluginAPI } from "@shiftlabs/codemode";
import {
  commandPath,
  packageVersion,
  pathExists,
  type ShellProgram,
  shellConnectionSchema,
  shellRunAction,
} from "@shiftlabs/codemode/utils/cli";

/**
 * Windows' own `bash.exe` starts WSL and passes `-c` arguments through
 * another shell, which re-reads their quoting. It takes the script on stdin.
 */
function startsWsl(path: string): boolean {
  const root = process.env.SystemRoot || "C:\\Windows";
  const normalized = win32.normalize(path).toLowerCase();
  return ["System32", "Sysnative"].some(
    (directory) =>
      normalized === win32.join(root, directory, "bash.exe").toLowerCase(),
  );
}

function program(path: string): ShellProgram {
  return startsWsl(path)
    ? { program: path, args: ["-s"], scriptOnStdin: true }
    : { program: path, args: ["-c"] };
}

/**
 * The bash to run: the one named, else `/bin/bash`, else `bash` on `PATH`,
 * else `sh`. On Windows: Git Bash where Git installs it, else `bash.exe` on
 * `PATH`.
 */
export function resolveBash(named?: string): ShellProgram {
  if (named) {
    if (!pathExists(named)) throw new Error(`bash: no shell at ${named}`);
    return program(named);
  }
  if (process.platform !== "win32") {
    if (pathExists("/bin/bash")) return program("/bin/bash");
    return program(commandPath("bash") ?? "sh");
  }
  const installed = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((root) => root !== undefined)
    .map((root) => win32.join(root, "Git", "bin", "bash.exe"));
  const found = installed.find(pathExists) ?? commandPath("bash.exe");
  if (!found)
    throw new Error(
      `bash: no bash found. Install Git for Windows, add a bash to PATH, or set the connection's "shell". Looked in: ${installed.join(", ")}`,
    );
  return program(found);
}

export default function bash(rl: CodemodePluginAPI): void {
  rl.setName("bash");
  rl.setVersion(packageVersion(import.meta.url));
  rl.setDescription(
    "Run bash commands on the machine codemode runs on, with the permissions of the codemode process.",
  );
  rl.setConnectionSchema(
    shellConnectionSchema("/bin/bash, else bash on PATH; on Windows, Git Bash"),
  );
  rl.registerAction(
    "run",
    shellRunAction({
      shell: "bash",
      outputFilePrefix: "codemode-bash",
      prepare: (command, shell) => ({
        program: resolveBash(shell),
        script: command,
      }),
    }),
  );
}
