/**
 * Bash for codemode: one action that runs a script on the machine codemode
 * runs on and answers what it wrote and how it ended.
 *
 *   const { output, exitCode } = await bash.run({ command: "git status --short" })
 *
 * Every call is a new process, so `cd` and variables do not carry from one
 * call to the next. The command ends with the run that started it.
 */

import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { resolve, win32 } from "node:path";
import type { CodemodePluginAPI } from "@shiftlabs/codemode";
import {
  commandPath,
  MAX_TIMEOUT_MS,
  runShell,
  type ShellProgram,
} from "@shiftlabs/codemode/utils/cli";
import * as t from "typebox";

/** The package's version is the plugin's. */
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/** Whether a path is there. Not `existsSync`: on Windows its extra check refuses runnable Store aliases. */
function present(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

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
    if (!present(named)) throw new Error(`bash: no shell at ${named}`);
    return program(named);
  }
  if (process.platform !== "win32") {
    if (present("/bin/bash")) return program("/bin/bash");
    return program(commandPath("bash") ?? "sh");
  }
  const installed = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((root) => root !== undefined)
    .map((root) => win32.join(root, "Git", "bin", "bash.exe"));
  const found = installed.find(present) ?? commandPath("bash.exe");
  if (!found)
    throw new Error(
      `bash: no bash found. Install Git for Windows, add a bash to PATH, or set the connection's "shell". Looked in: ${installed.join(", ")}`,
    );
  return program(found);
}

const runInput = t.Object(
  {
    command: t.String({
      minLength: 1,
      description:
        "The script to run. Each call is a new process: `cd` and variables do not carry over to the next call.",
    }),
    cwd: t.Optional(
      t.String({
        minLength: 1,
        description:
          "Working directory. A relative path resolves from the connection's `cwd`. Default: the connection's `cwd`, else the directory codemode runs in.",
      }),
    ),
    timeoutMs: t.Optional(
      t.Integer({
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description:
          "End the command, and what it started, after this many milliseconds. Default: no limit of its own; the command ends when the run does.",
      }),
    ),
  },
  { additionalProperties: false },
);

const runOutput = {
  type: "object",
  properties: {
    output: {
      type: "string",
      description:
        "stdout and stderr together. Past 1 MiB: its start and end around a note of what was left out.",
    },
    exitCode: {
      type: "number",
      description:
        "The command's exit code. A command a signal ended has 128 plus the signal's number.",
    },
    truncated: { type: "boolean" },
    fullOutputPath: {
      type: "string",
      description: "The file with all of the output, when `truncated`.",
    },
    wallTimeMs: { type: "number" },
  },
  required: ["output", "exitCode", "truncated", "wallTimeMs"],
};

export default function bash(rl: CodemodePluginAPI): void {
  rl.setName("bash");
  rl.setVersion(version);
  rl.setDescription(
    "Run bash commands on the machine codemode runs on, with the permissions of the codemode process.",
  );
  rl.setConnectionSchema(
    t.Object({
      cwd: t.Optional(
        t.String({
          description:
            "The directory commands run in. Default: the directory codemode runs in.",
        }),
      ),
      shell: t.Optional(
        t.String({
          description:
            "Path of the shell to run commands with. Default: /bin/bash, else bash on PATH; on Windows, Git Bash.",
        }),
      ),
    }),
  );

  rl.registerAction("run", {
    access: "write",
    description:
      "Run a bash command and return its output and exit code. A command that exits with a failure still returns: check `exitCode`. A command that cannot start, or that outlives `timeoutMs`, rejects.",
    hints: { destructive: true, openWorld: true },
    inputSchema: runInput,
    outputSchema: runOutput,
    execute({ command, cwd, timeoutMs }, ctx) {
      const { config } = ctx.connection;
      const base =
        typeof config.cwd === "string" && config.cwd ? config.cwd : undefined;
      return runShell(
        resolveBash(
          typeof config.shell === "string" ? config.shell : undefined,
        ),
        command,
        {
          cwd: cwd === undefined ? base : resolve(base ?? process.cwd(), cwd),
          timeoutMs,
          signal: ctx.signal,
          outputDir: ctx.outputDir,
          outputFilePrefix: "codemode-bash",
        },
      );
    },
  });
}
