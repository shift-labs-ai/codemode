import type { ActionContext } from "../plugin/types.js";
import { inheritedEnvironment } from "./environment.js";
import {
  checkedOutputBytes,
  endedEarly,
  type ProcessEnd,
  runProcess,
  ShellOutput,
} from "./shell.js";
import { shapeSpawn } from "./spawn.js";

export interface RunCommandOptions {
  /** Working directory. Default: the host process's. */
  cwd?: string;
  /**
   * The variables the program needs besides the few every program gets
   * (`INHERITED_ENVIRONMENT`). It gets nothing else of the host's.
   */
  env?: Readonly<Record<string, string>>;
  /** After this long the program's process group is killed and the call rejects. Default: no limit of its own. */
  timeoutMs?: number;
}

export interface CommandOutput {
  /** What the program wrote to stdout, up to `ctx.maxOutputBytes`. Past that: its last lines, then a line that says which lines they are and names the file with all of it. */
  stdout: string;
  /** What it wrote to stderr, within the same bound and cut the same way. */
  stderr: string;
  /** The program's exit code. One ended by a signal has 128 plus the signal's number. */
  exitCode: number;
  /** Whether `stdout` is only the end of what the program wrote there. */
  truncated: boolean;
  /** The file holding all of stdout, when `stdout` does not. */
  fullOutputPath?: string;
  wallTimeMs: number;
}

/** The start of an output file's name for a program: its own name, without what a file's name cannot hold. */
function filePrefix(program: string): string {
  const name = program.split(/[\\/]/).pop() ?? "";
  return `codemode-${name.replace(/[^A-Za-z0-9._-]/g, "") || "command"}`;
}

/**
 * Run a program with an argument list, and no shell, and answer what it
 * wrote and how it ended. Call it from an action with the action's `ctx`:
 * the program ends with the run, holds as much output as the host allows,
 * and is started as the host's `spawnHook` says.
 *
 * A program that exits with a failure is a result, with its exit code; one
 * that could not start, outlived `timeoutMs` or was aborted is a
 * `ShellError`.
 */
export async function runCommand(
  ctx: ActionContext,
  program: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<CommandOutput> {
  const limits = { timeoutMs: options.timeoutMs, signal: ctx.signal };
  const maxOutputBytes = checkedOutputBytes({
    ...limits,
    maxOutputBytes: ctx.maxOutputBytes,
  });
  const added = { ...options.env };
  const command = await shapeSpawn(
    ctx,
    {
      program,
      args: [...args],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...inheritedEnvironment(), ...added },
    },
    added,
  );
  const prefix = filePrefix(program);
  const output = {
    stdout: new ShellOutput(maxOutputBytes, prefix, ctx.outputDir),
    stderr: new ShellOutput(maxOutputBytes, `${prefix}-stderr`, ctx.outputDir),
  };
  const finish = async () => ({
    stdout: await output.stdout.finish(),
    stderr: await output.stderr.finish(),
  });
  let end: ProcessEnd;
  try {
    end = await runProcess(command, {
      ...limits,
      take: (chunk, from) => output[from].append(chunk),
      drained: async () => {
        await Promise.all([output.stdout.drained(), output.stderr.drained()]);
      },
    });
  } catch (error) {
    await finish();
    throw error;
  }
  const { stdout, stderr } = await finish();
  // What an error quotes is what explains it: stderr, when there is some.
  const early = endedEarly(end, limits, stderr.text.trim() ? stderr : stdout);
  if (early) throw early;
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: end.exitCode,
    truncated: stdout.truncated,
    ...(stdout.path === undefined ? {} : { fullOutputPath: stdout.path }),
    wallTimeMs: end.wallTimeMs,
  };
}

/**
 * Run a binary the plugin declares, by its name there, as `runCommand` runs
 * a program. A binary that is not installed rejects as `ctx.binary` does.
 */
export async function runBinary(
  ctx: ActionContext,
  name: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<CommandOutput> {
  if (!ctx.binary)
    throw new Error(
      "runBinary takes the context of a call the engine dispatched",
    );
  return runCommand(ctx, await ctx.binary(name), args, options);
}
