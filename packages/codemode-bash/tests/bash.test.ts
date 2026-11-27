/**
 * The bash package: its one action through a real engine and a real shell,
 * and the package as codemode's package manager loads it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Codemode } from "@shiftlabs/codemode";
import type { ShellResult } from "@shiftlabs/codemode/utils/cli";
import { ends, pidIn } from "../../codemode/src/tests/helpers/processes.js";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import { assertLargeOutputIsCutForTheRun } from "../../package-tests/shell.js";
import bash, { resolveBash } from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const posix = process.platform === "win32" ? it.skip : it;

const harness = pluginHarness(bash, "bash");
const codemode = harness.codemode;
const run = (
  input: Record<string, unknown>,
  config?: Record<string, unknown>,
) => harness.call<ShellResult>("run", input, config);

describe("bash.run", () => {
  posix("returns a command's output and exit code", async () => {
    const result = await run({ command: "echo hello; echo problem >&2" });
    assert.deepEqual(result.output.trim().split("\n").sort(), [
      "hello",
      "problem",
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
  });

  posix(
    "returns a failing command's exit code, where code can read it",
    async () => {
      const { result, error } = await codemode().execute(`
      const found = await bash.run({ command: "echo looked; exit 3" });
      return found.exitCode === 0 ? "found" : "exit " + found.exitCode + ": " + found.output.trim();
    `);
      assert.equal(error, undefined);
      assert.equal(result, "exit 3: looked");
    },
  );

  posix("is bash, where there is one", async () => {
    const { output } = await run({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
      command: 'echo "${BASH_VERSION:+bash}"',
    });
    assert.equal(output.trim(), existsSync("/bin/bash") ? "bash" : "");
  });

  posix("starts each call afresh", async () => {
    const { result } = await codemode({ cwd: harness.tmp }).execute(`
      await bash.run({ command: "cd / && export KEPT=1" });
      return (await bash.run({ command: 'pwd; echo "kept=$KEPT"' })).output;
    `);
    assert.equal(result, `${harness.tmp}\nkept=\n`);
  });

  posix(
    "runs in the connection's directory, or the call's within it",
    async () => {
      mkdirSync(join(harness.tmp, "inner"));
      assert.equal(
        (await run({ command: "pwd" }, { cwd: harness.tmp })).output,
        `${harness.tmp}\n`,
      );
      assert.equal(
        (await run({ command: "pwd", cwd: "inner" }, { cwd: harness.tmp }))
          .output,
        `${join(harness.tmp, "inner")}\n`,
      );
      const { error } = await codemode({ cwd: harness.tmp }).execute(
        `return await bash.run({ command: "pwd", cwd: "missing" })`,
      );
      assert.match(error ?? "", /Working directory does not exist/);
    },
  );

  posix(
    "rejects a command that outlives its timeout, with what it wrote",
    async () => {
      const { error } = await codemode().execute(
        `return await bash.run({ command: "echo started; sleep 30", timeoutMs: 1000 })`,
      );
      assert.match(error ?? "", /started\n\nCommand timed out after 1 seconds/);
    },
  );

  posix(
    "ends the command, and what it started, when the run ends first",
    async () => {
      const pidFile = join(harness.tmp, "pid");
      const { error } = await codemode().execute(
        `return await bash.run({ command: "sleep 30 & echo $! > ${pidFile}; wait" })`,
        { timeoutMs: 1_500 },
      );
      assert.match(error ?? "", /timed out/);
      assert.equal(await ends(await pidIn(pidFile)), true);
    },
  );

  posix("hands code all of a large output, and the run its last lines", () =>
    assertLargeOutputIsCutForTheRun(
      harness,
      `bash.run({ command: "head -c 1500000 /dev/zero | tr '\\\\0' a; echo END; exit 4" })`,
    ),
  );

  posix("is started as the host's spawnHook says, or not at all", async () => {
    const host = Codemode.create({
      plugins: [bash],
      connections: [
        { name: "bash", plugin: "bash", config: { env: { NAMED: "named" } } },
      ],
      spawnHook: (command, call) => {
        if (command.script?.includes("rm -rf"))
          throw new Error("Refused by the host");
        return {
          ...command,
          cwd: harness.tmp,
          env: {
            PATH: process.env.PATH ?? "",
            HOSTED: "hosted",
            ...call.added,
          },
        };
      },
    });
    process.env.CODEMODE_BASH_TEST_HOST = "from-host";
    try {
      const ran = await host.execute(
        'return await bash.run({ command: "pwd -P; echo $HOSTED $NAMED $CODEMODE_BASH_TEST_HOST." })',
      );
      assert.equal(ran.error, undefined);
      const [cwd, variables] = (ran.result as ShellResult).output
        .trim()
        .split("\n");
      assert.equal(realpathSync(cwd), realpathSync(harness.tmp));
      assert.equal(variables, "hosted named .");
      const refused = await host.execute(
        'return await bash.run({ command: "rm -rf /tmp/codemode-nothing" })',
      );
      assert.match(refused.error ?? "", /Refused by the host/);
    } finally {
      delete process.env.CODEMODE_BASH_TEST_HOST;
      host.dispose();
    }
  });

  posix(
    "hands its output to a host that follows the run, and ends when the host stops it",
    async () => {
      const stop = new AbortController();
      const pidFile = join(harness.tmp, "followed-pid");
      const seen: string[] = [];
      const run = codemode().execute(
        `return await bash.run({ command: "sleep 30 & echo $! > ${pidFile}; echo started; wait" })`,
        {
          signal: stop.signal,
          timeoutMs: 0,
          onOutput: ({ path, text }) => {
            seen.push(`${path}: ${text}`);
            stop.abort();
          },
        },
      );
      assert.equal((await run).error, "Execution aborted");
      assert.deepEqual(seen, ["bash.run: started\n"]);
      assert.equal(await ends(await pidIn(pidFile)), true);
    },
  );

  it("refuses input that is not a command", async () => {
    for (const input of [{}, { command: "" }, { command: "ls", timeout: 5 }]) {
      const { error } = await codemode().execute(
        `return await bash.run(${JSON.stringify(input)})`,
      );
      assert.match(error ?? "", /Invalid input for bash\.run/);
    }
  });
});

describe("the shell bash.run uses", () => {
  posix("is the one the connection names", async () => {
    const result = await run({ command: "echo from $0" }, { shell: "/bin/sh" });
    assert.equal(result.output, "from /bin/sh\n");
    assert.deepEqual(resolveBash("/bin/sh"), {
      program: "/bin/sh",
      args: ["-c"],
    });
  });

  it("is refused when it is not there", () => {
    assert.throws(
      () => resolveBash(join(harness.tmp, "no-such-shell")),
      /bash: no shell at /,
    );
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-bash",
  plugin: "bash",
  actions: 1,
  write: 1,
});
