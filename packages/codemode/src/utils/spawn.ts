/**
 * How a host shapes the commands actions start. A host sets one `spawnHook`;
 * the engine binds it to each call's context, and `runShell` and `runProgram`
 * apply it before they start a process. A plugin does not hold the hook.
 */

/** A command about to be started. */
export interface SpawnCommand {
  /** The program to start. */
  program: string;
  /** Its arguments. A shell's script is not among them: it is `script`. */
  args: string[];
  /**
   * The script a shell or an interpreter is handed, as its last argument or
   * on stdin. Absent when the command is a program run with arguments only.
   */
  script?: string;
  /** Working directory. Absent: the host process's. */
  cwd?: string;
  /** The command's whole environment. */
  env: Record<string, string>;
}

/** The action call a command is started for. */
export interface SpawnCall {
  plugin: string;
  action: string;
  /** The run's `context`, as the host passed it to `execute()`. */
  context: unknown;
  /**
   * The variables the plugin and its connection name for this command.
   * `env` already holds them: a host that builds an environment of its own
   * adds these to it.
   */
  added: Readonly<Record<string, string>>;
}

/**
 * Decides how a command is started: answers the command to start in place
 * of the one it is given. Throwing refuses the command, and the action
 * rejects with what was thrown.
 */
export type SpawnHook = (
  command: SpawnCommand,
  call: SpawnCall,
) => SpawnCommand | Promise<SpawnCommand>;

/** A hook bound to one action call. */
type BoundSpawnHook = (
  command: SpawnCommand,
  added: Readonly<Record<string, string>>,
) => Promise<SpawnCommand>;

/**
 * Where a call's context carries its hook. Registered, so a package that
 * loads a copy of codemode of its own reads the same key, and not part of
 * `ActionContext`, so an action has nothing to call.
 */
const SPAWN_HOOK = Symbol.for("@shiftlabs/codemode.spawnHook");

function isCommand(value: unknown): value is SpawnCommand {
  if (typeof value !== "object" || value === null) return false;
  const { program, args, script, cwd, env } = value as Record<string, unknown>;
  return (
    typeof program === "string" &&
    program !== "" &&
    Array.isArray(args) &&
    args.every((arg) => typeof arg === "string") &&
    (script === undefined || typeof script === "string") &&
    (cwd === undefined || typeof cwd === "string") &&
    typeof env === "object" &&
    env !== null &&
    Object.values(env).every((entry) => typeof entry === "string")
  );
}

/**
 * Bind a host's hook to the context of one action call. Enumerable, so a
 * context an action copies with a spread still carries it.
 */
export function bindSpawnHook(
  ctx: object,
  hook: SpawnHook,
  call: Omit<SpawnCall, "added">,
): void {
  const bound: BoundSpawnHook = async (command, added) => {
    const shaped = await hook(command, { ...call, added });
    if (!isCommand(shaped))
      throw new Error(
        "spawnHook must answer a command: { program, args, env } with an optional script and cwd",
      );
    // A shell's script stays a script, and a program run with arguments gets none.
    if ((shaped.script === undefined) !== (command.script === undefined))
      throw new Error(
        "spawnHook must keep a command's script, and add none to a command without one",
      );
    return shaped;
  };
  Object.defineProperty(ctx, SPAWN_HOOK, { value: bound, enumerable: true });
}

/**
 * The command as the host of this call wants it started: `command` itself
 * when there is no call or its host set no hook.
 */
export async function shapeSpawn(
  ctx: object | undefined,
  command: SpawnCommand,
  added: Readonly<Record<string, string>> = {},
): Promise<SpawnCommand> {
  const bound = (ctx as { [SPAWN_HOOK]?: BoundSpawnHook } | undefined)?.[
    SPAWN_HOOK
  ];
  return bound ? bound(command, added) : command;
}
