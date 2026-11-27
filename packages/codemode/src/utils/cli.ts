import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";
import { pathExists } from "./shell-action.js";

/** A variable's value on Windows, which writes its name in any case, such as `Path`. */
function windowsVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === name,
  );
  return key === undefined ? undefined : env[key];
}

/** Whether a path is a file this process may execute. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a command is on `PATH`, when it is there. `PATH` is read in this
 * process and no program is started. A name with a directory in it is not
 * looked up: it is a path already.
 *
 * On Windows a name with none of `PATHEXT`'s extensions is tried with each
 * of them. The working directory is not searched, on any system, so a
 * program placed there is never taken for one on `PATH`.
 */
export function commandPath(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!name || /[\\/]/.test(name)) return undefined;
  const windows = platform === "win32";
  const directories = (
    (windows ? windowsVariable(env, "PATH") : env.PATH) ?? ""
  )
    .split(windows ? ";" : ":")
    .filter(Boolean);
  let names = [name];
  if (windows) {
    const extensions = (
      windowsVariable(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD"
    )
      .split(";")
      .filter(Boolean);
    const own = extname(name).toUpperCase();
    if (!extensions.some((extension) => extension.toUpperCase() === own))
      names = extensions.map((extension) => `${name}${extension}`);
  }
  // Windows has no execute bit, and `pathExists` accepts its Store aliases.
  const found = windows ? pathExists : isExecutable;
  for (const directory of directories)
    for (const candidate of names) {
      const path = join(directory, candidate);
      if (found(path)) return path;
    }
  return undefined;
}

export function commandExists(name: string): boolean {
  return commandPath(name) !== undefined;
}

export { packageBinaries } from "../binaries/declaration.js";
export { packageVersion } from "./package-version.js";
export {
  type ProgramResult,
  type RunProgramOptions,
  runBinary,
  runProgram,
} from "./program.js";
export {
  isShellError,
  killProcessTree,
  type RunShellOptions,
  runShell,
  ShellError,
  type ShellErrorCode,
  type ShellProgram,
  type ShellResult,
} from "./shell.js";
export {
  pathExists,
  type ShellRunActionOptions,
  shellConnectionSchema,
  shellRunAction,
} from "./shell-action.js";
export type { SpawnCall, SpawnCommand, SpawnHook } from "./spawn.js";
export { MAX_TIMEOUT_MS } from "./timers.js";
