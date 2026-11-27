import type { ActionContext } from "../plugin/types.js";
import { inheritedEnvironment } from "./environment.js";
import { OutputFollower } from "./follow.js";
import {
  checkedOutputBytes,
  endedEarly,
  type ProcessEnd,
  runProcess,
  ShellOutput,
} from "./shell.js";
import { shapeSpawn } from "./spawn.js";

export interface RunProgramOptions {
  /** Working directory. Default: the host process's. */
  cwd?: string;
  /**
   * The variables the program needs besides the few every program gets
   * (`INHERITED_ENVIRONMENT`). It gets nothing else of the host's.
   */
  env?: Readonly<Record<string, string>>;
  /** After this long the program is ended and the call rejects. Default: no limit of its own. */
  timeoutMs?: number;
}

export interface ProgramResult {
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
  return `codemode-${name.replace(/[^A-Za-z0-9._-]/g, "") || "program"}`;
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
export async function runProgram(
  ctx: ActionContext,
  program: string,
  args: readonly string[] = [],
  options: RunProgramOptions = {},
): Promise<ProgramResult> {
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
  const follower = new OutputFollower(ctx.output);
  let end: ProcessEnd;
  try {
    end = await runProcess(command, {
      ...limits,
      take: (chunk, from) => {
        const kept = output[from].append(chunk);
        return follower.take(chunk, from) && kept;
      },
      drained: async () => {
        await Promise.all([
          output.stdout.drained(),
          output.stderr.drained(),
          follower.drained(),
        ]);
      },
    });
  } catch (error) {
    await finish();
    throw error;
  }
  await follower.finish();
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
 * Run a binary the plugin declares, by its name there, as `runProgram` runs
 * a program. A binary that is not installed rejects as `ctx.binary` does.
 */
export async function runBinary(
  ctx: ActionContext,
  name: string,
  args: readonly string[] = [],
  options: RunProgramOptions = {},
): Promise<ProgramResult> {
  if (!ctx.binary)
    throw new Error(
      "runBinary takes the context of a call the engine dispatched",
    );
  return runProgram(ctx, await ctx.binary(name), args, options);
}
