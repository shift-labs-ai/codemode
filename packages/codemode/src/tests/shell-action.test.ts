/**
 * The `run` action shell plugins share, as a plugin of this file's own
 * registers it: what `prepare` is told, and what the shell is run with.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CodemodePluginAPI } from "../plugin/api.js";
import { Codemode } from "../sdk.js";
import type { ShellResult } from "../utils/shell.js";
import {
  pathExists,
  shellConnectionSchema,
  shellRunAction,
} from "../utils/shell-action.js";

const posix = process.platform === "win32" ? it.skip : it;

let tmp: string;
let asked: Array<{ command: string; shell: string | undefined }>;
const instances: Codemode[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codemode-shell-action-")));
  asked = [];
});

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A shell plugin over `/bin/sh` that puts a line before each command. */
function sh(rl: CodemodePluginAPI): void {
  rl.setName("sh");
  rl.setVersion("1.0.0");
  rl.setConnectionSchema(shellConnectionSchema("/bin/sh"));
  rl.registerAction(
    "run",
    shellRunAction({
      shell: "sh",
      outputFilePrefix: "codemode-sh",
      prepare: (command, shell) => {
        asked.push({ command, shell });
        return {
          program: { program: shell ?? "/bin/sh", args: ["-c"] },
          script: `echo before\n${command}`,
          env: { CODEMODE_SHELL_ACTION: "set" },
        };
      },
    }),
  );
}

async function run(
  input: Record<string, unknown>,
  config: Record<string, unknown> = {},
): Promise<ShellResult> {
  const codemode = Codemode.create({
    plugins: [sh],
    connections: [{ name: "sh", plugin: "sh", config }],
  });
  instances.push(codemode);
  const { result, error } = await codemode.execute(
    `return await sh.run(${JSON.stringify(input)})`,
  );
  assert.equal(error, undefined);
  return result as ShellResult;
}

describe("a shell plugin's run action", () => {
  posix("runs the script and environment the plugin prepares", async () => {
    const result = await run({ command: "echo $CODEMODE_SHELL_ACTION" });
    assert.equal(result.output, "before\nset\n");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(asked, [
      { command: "echo $CODEMODE_SHELL_ACTION", shell: undefined },
    ]);
  });

  posix(
    "tells the plugin the shell the connection names, when it names one",
    async () => {
      await run({ command: "true" }, { shell: "/bin/sh" });
      await run({ command: "true" }, { shell: "" });
      assert.deepEqual(
        asked.map(({ shell }) => shell),
        ["/bin/sh", undefined],
      );
    },
  );

  posix(
    "runs in the connection's directory, or the call's within it",
    async () => {
      mkdirSync(join(tmp, "inner"));
      const where = async (
        input: Record<string, unknown>,
        config: Record<string, unknown>,
      ) => (await run({ command: "pwd", ...input }, config)).output;
      assert.equal(await where({}, { cwd: tmp }), `before\n${tmp}\n`);
      assert.equal(
        await where({ cwd: "inner" }, { cwd: tmp }),
        `before\n${join(tmp, "inner")}\n`,
      );
      assert.equal(
        await where({ cwd: join(tmp, "inner") }, {}),
        `before\n${join(tmp, "inner")}\n`,
      );
    },
  );

  it("is a write that says which shell it runs", () => {
    const action = shellRunAction({
      shell: "sh",
      outputFilePrefix: "codemode-sh",
      prepare: () => ({ program: { program: "sh", args: [] }, script: "" }),
    });
    assert.equal(action.access, "write");
    assert.match(action.description ?? "", /^Run a sh script/);
  });
});

describe("whether a path is there", () => {
  it("is so for a file and a directory, and not for neither", () => {
    assert.equal(pathExists(tmp), true);
    assert.equal(pathExists(join(tmp, "missing")), false);
  });
});
