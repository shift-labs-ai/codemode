import { inheritedEnvironment } from "../mcp/values.js";
import type { ActionContext } from "../plugin/types.js";
import {
  checkedOutputBytes,
  endedEarly,
  type ProcessEnd,
  runProcess,
  ShellOutput,
} from "./shell.js";
import { shapeSpawn } from "./spawn.js";

export interface RunBinaryOptions {
  /** Working directory. Default: the host process's. */
  cwd?: string;
  /**
   * The variables the binary needs besides the few every program gets
   * (`inheritedEnvironment()`). It gets nothing else of the host's.
   */
  env?: Readonly<Record<string, string>>;
  /** After this long the binary's process group is killed and the call rejects. Default: no limit of its own. */
  timeoutMs?: number;
}

export interface BinaryResult {
  /** What the binary wrote to stdout, up to `ctx.maxOutputBytes`. Past that: its last lines, then a line that says which lines they are. */
  stdout: string;
  /** What it wrote to stderr, within the same bound. */
  stderr: string;
  /** The binary's exit code. One ended by a signal has 128 plus the signal's number. */
  exitCode: number;
  /** Whether `stdout` is only the end of what the binary wrote there. */
  truncated: boolean;
  /** The file holding all of stdout, when `stdout` does not. */
  fullOutputPath?: string;
  wallTimeMs: number;
}

/**
 * Run a binary the plugin declares, by its name there, and answer what it
 * wrote and how it ended. Call it from an action with the action's `ctx`:
 * the binary ends with the run, and the host's `spawnHook` shapes how it is
 * started.
 *
 * A binary that exits with a failure is a result, with its exit code; one
 * that is not installed rejects as `ctx.binary` does, and one that could
 * not start, outlived `timeoutMs` or was aborted is a `ShellError`.
 */
export async function runBinary(
  ctx: ActionContext,
  name: string,
  args: readonly string[] = [],
  options: RunBinaryOptions = {},
): Promise<BinaryResult> {
  if (!ctx.binary)
    throw new Error(
      "runBinary takes the context of a call the engine dispatched",
    );
  const limits = { timeoutMs: options.timeoutMs, signal: ctx.signal };
  const maxOutputBytes = checkedOutputBytes({
    ...limits,
    maxOutputBytes: ctx.maxOutputBytes,
  });
  const added = { ...options.env };
  const command = await shapeSpawn(
    ctx,
    {
      program: await ctx.binary(name),
      args: [...args],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...inheritedEnvironment(), ...added },
    },
    added,
  );
  const output = {
    stdout: new ShellOutput(maxOutputBytes, `codemode-${name}`, ctx.outputDir),
    stderr: new ShellOutput(
      maxOutputBytes,
      `codemode-${name}-stderr`,
      ctx.outputDir,
    ),
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
      drained: () =>
        Promise.all([output.stdout.drained(), output.stderr.drained()]).then(
          () => {},
        ),
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
