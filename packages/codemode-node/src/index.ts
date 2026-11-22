/**
 * Node for codemode: one action that runs JavaScript in Node.js on the
 * machine codemode runs on and answers what it wrote and how it ended.
 *
 *   const { output } = await node.run({ command: 'console.log(require("node:os").platform())' })
 *
 * Every call is a new process, so variables do not carry from one call to
 * the next. The script ends with the run that started it.
 */

import type { CodemodePluginAPI } from "@shiftlabs/codemode";
import {
  commandPath,
  packageVersion,
  pathExists,
  type ShellProgram,
  shellConnectionSchema,
  shellRunAction,
} from "@shiftlabs/codemode/utils/cli";

/** Whether codemode itself runs in Node.js, and not in a runtime that imitates it. */
function hostIsNode(): boolean {
  return process.release.name === "node" && !("bun" in process.versions);
}

/**
 * The Node.js to run: the one named, else `node` on `PATH`, else the one
 * codemode runs in. It reads the script from stdin, so that the script is
 * no argument a shell or an operating system could cut or re-read.
 */
export function resolveNode(named?: string): ShellProgram {
  if (named && !pathExists(named))
    throw new Error(`node: no Node.js at ${named}`);
  const found =
    named ??
    commandPath("node") ??
    (hostIsNode() ? process.execPath : undefined);
  if (!found)
    throw new Error(
      'node: no Node.js found. Install Node.js, add node to PATH, or set the connection\'s "shell".',
    );
  return { program: found, args: ["-"], scriptOnStdin: true };
}

export default function node(rl: CodemodePluginAPI): void {
  rl.setName("node");
  rl.setVersion(packageVersion(import.meta.url));
  rl.setDescription(
    "Run JavaScript in Node.js on the machine codemode runs on, with the permissions of the codemode process.",
  );
  rl.setConnectionSchema(shellConnectionSchema("node on PATH"));
  rl.registerAction(
    "run",
    shellRunAction({
      shell: "Node.js",
      outputFilePrefix: "codemode-node",
      prepare: (command, shell) => ({
        program: resolveNode(shell),
        script: command,
      }),
    }),
  );
}
