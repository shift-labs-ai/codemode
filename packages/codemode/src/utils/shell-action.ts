/**
 * The `run` action of a plugin that runs scripts through a program, such as
 * a shell or an interpreter: one input, one result and one set of rules,
 * whichever program it is. A plugin says which program that is and how a
 * call's `command` becomes its script.
 */

import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import * as t from "typebox";
import type { ActionDefinition } from "../plugin/api.js";
import { ACTION_MEMORY_BYTES } from "./output-files.js";
import { formatSize } from "./output-limit.js";
import { runShell, type ShellProgram } from "./shell.js";
import { MAX_TIMEOUT_MS } from "./timers.js";

/** Whether a path is there. Not `existsSync`: on Windows its extra check refuses runnable Store aliases. */
export function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const shellRunInput = t.Object(
  {
    command: t.String({
      minLength: 1,
      description:
        "The script to run. Each call is a new process: a changed directory and variables do not carry over to the next call.",
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
          "End the script, and what it started, after this many milliseconds. Default: no limit of its own; the script ends when the run does.",
      }),
    ),
  },
  { additionalProperties: false },
);

const shellRunOutput = {
  type: "object",
  properties: {
    output: {
      type: "string",
      description: `stdout and stderr together, all of it up to what the host lets an action hold, ${formatSize(ACTION_MEMORY_BYTES)} by default. Past that: its last lines, then a line that says which lines they are.`,
    },
    exitCode: {
      type: "number",
      description:
        "The program's exit code. A program a signal ended has 128 plus the signal's number.",
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

/**
 * The connection of such a plugin: where scripts run, and which program
 * runs them. `defaultShell` says in words what runs when none is named.
 */
export function shellConnectionSchema(defaultShell: string) {
  return t.Object({
    cwd: t.Optional(
      t.String({
        description:
          "The directory scripts run in. Default: the directory codemode runs in.",
      }),
    ),
    shell: t.Optional(
      t.String({
        description: `Path of the program that runs scripts. Default: ${defaultShell}.`,
      }),
    ),
  });
}

export interface ShellRunActionOptions {
  /** The program's name as the action's description says it: `bash`, `PowerShell`, `Node.js`. */
  shell: string;
  /** The start of the name of the file that keeps output past `ctx.maxOutputBytes`. */
  outputFilePrefix: string;
  /**
   * The program a call runs, from the one the connection names as `shell`
   * when it names one, the script that program is handed for a command, and
   * what the program needs added to its environment.
   */
  prepare(
    command: string,
    shell: string | undefined,
  ): {
    program: ShellProgram;
    script: string;
    env?: Readonly<Record<string, string>>;
  };
}

/** A connection value that is text with something in it. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Such a plugin's `run` action. It runs on the machine codemode runs on,
 * so it is a write whatever the script does, and it ends with the run
 * that called it.
 */
export function shellRunAction(
  options: ShellRunActionOptions,
): ActionDefinition<typeof shellRunInput> {
  return {
    access: "write",
    description: `Run a ${options.shell} script and return its output and exit code. A script that ends with a failure still returns: check \`exitCode\`. A script that cannot start, or that outlives \`timeoutMs\`, rejects.`,
    hints: { destructive: true, openWorld: true },
    inputSchema: shellRunInput,
    outputSchema: shellRunOutput,
    execute({ command, cwd, timeoutMs }, ctx) {
      const { config } = ctx.connection;
      const base = text(config.cwd);
      const { program, script, env } = options.prepare(
        command,
        text(config.shell),
      );
      return runShell(program, script, {
        cwd: cwd === undefined ? base : resolve(base ?? process.cwd(), cwd),
        env,
        timeoutMs,
        signal: ctx.signal,
        maxOutputBytes: ctx.maxOutputBytes,
        outputDir: ctx.outputDir,
        outputFilePrefix: options.outputFilePrefix,
      });
    },
  };
}
