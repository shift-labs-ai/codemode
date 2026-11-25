import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { binaryPlatform } from "../binaries/declaration.js";
import { BinaryManager } from "../binaries/manager.js";
import type { PluginFunction } from "../plugin/api.js";
import { Codemode } from "../sdk.js";
import {
  type BinaryResult,
  runBinary,
  type ShellResult,
  type SpawnCall,
  type SpawnCommand,
  type SpawnHook,
  shellConnectionSchema,
  shellRunAction,
} from "../utils/cli.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "codemode-spawn-")));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The programs here are shell scripts. */
const skip = process.platform === "win32";

/** A binary that prints its arguments and the variables these tests set. */
const SCRIPT = Buffer.from(`#!/bin/sh
echo "args=$*"
echo "secret=\${CODEMODE_TEST_SECRET:-none}"
echo "named=\${NAMED:-none}"
echo "host=\${FROM_HOST:-none}"
`);
const URL = "https://downloads.test/show";

/** A plugin with a `sh` action, as the shell packages have, and one that runs a declared binary. */
const demo: PluginFunction = (rl) => {
  rl.setName("demo");
  rl.setConnectionSchema(shellConnectionSchema("sh"));
  rl.setBinaries({
    show: {
      platforms: {
        [binaryPlatform()]: {
          size: SCRIPT.length,
          hash: "sha256",
          digest: createHash("sha256").update(SCRIPT).digest("hex"),
          path: "show",
          providers: [{ url: URL }],
        },
      },
    },
  });
  rl.registerAction(
    "run",
    shellRunAction({
      shell: "sh",
      outputFilePrefix: "codemode-spawn-test",
      prepare: (command) => ({
        program: { program: "/bin/sh", args: ["-c"] },
        script: command,
        env: { FROM_PLUGIN: "plugin" },
      }),
    }),
  );
  rl.registerAction("show", {
    execute: (input, ctx) =>
      runBinary(ctx, "show", (input as { args?: string[] }).args ?? [], {
        env: { NAMED: "yes" },
      }),
  });
};

async function host(spawnHook?: SpawnHook) {
  const codemode = Codemode.create({
    plugins: [demo],
    connections: [
      {
        name: "demo",
        plugin: "demo",
        config: { env: { FROM_CONNECTION: "connection" } },
      },
    ],
    binaries: new BinaryManager({
      dir: join(dir, "bin"),
      fetch: (async (_url: RequestInfo | URL) =>
        new Response(new Uint8Array(SCRIPT))) as typeof fetch,
    }),
    spawnHook,
  });
  await codemode.binaries.install();
  return codemode;
}

describe("a host's spawnHook", { skip }, () => {
  it("shapes a shell's script and a declared binary through the one function", async () => {
    const seen: Array<{ command: SpawnCommand; call: SpawnCall }> = [];
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    process.env.CODEMODE_TEST_SECRET = "leaked";
    const codemode = await host((command, call) => {
      seen.push({ command, call });
      return {
        // A binary is started through another program; a script is rewritten.
        ...(command.script === undefined
          ? {
              program: "/usr/bin/env",
              args: [command.program, ...command.args],
            }
          : {
              program: command.program,
              args: command.args,
              script: `FROM_HOOK=hook; ${command.script}`,
            }),
        cwd: elsewhere,
        // An environment of the host's own making, plus what was named.
        env: { PATH: process.env.PATH ?? "", FROM_HOST: "host", ...call.added },
      };
    });
    try {
      const shell = await codemode.execute(
        'return await demo.run({ command: "pwd; echo $FROM_HOOK $FROM_HOST $FROM_PLUGIN $FROM_CONNECTION $CODEMODE_TEST_SECRET." })',
        { context: { run: 7 } },
      );
      assert.equal(shell.error, undefined);
      assert.equal(
        (shell.result as ShellResult).output,
        `${elsewhere}\nhook host plugin connection .\n`,
      );
      const binary = await codemode.execute(
        'return await demo.show({ args: ["a", "b"] })',
        { context: { run: 8 } },
      );
      assert.equal(binary.error, undefined);
      assert.equal(
        (binary.result as BinaryResult).stdout,
        "args=a b\nsecret=none\nnamed=yes\nhost=host\n",
      );

      const [first, second] = seen;
      assert.deepEqual(first.call, {
        plugin: "demo",
        action: "run",
        context: { run: 7 },
        added: { FROM_PLUGIN: "plugin", FROM_CONNECTION: "connection" },
      });
      assert.deepEqual(first.command.args, ["-c"]);
      // A script starts with the host's environment unless the hook says otherwise.
      assert.equal(first.command.env.CODEMODE_TEST_SECRET, "leaked");
      assert.deepEqual(second.call, {
        plugin: "demo",
        action: "show",
        context: { run: 8 },
        added: { NAMED: "yes" },
      });
      assert.equal(second.command.script, undefined);
      assert.deepEqual(second.command.args, ["a", "b"]);
      // A binary starts without it.
      assert.equal(second.command.env.CODEMODE_TEST_SECRET, undefined);
      assert.equal(second.command.env.NAMED, "yes");
    } finally {
      delete process.env.CODEMODE_TEST_SECRET;
      codemode.dispose();
    }
  });

  it("refuses a command by throwing, before anything starts", async () => {
    const marker = join(dir, "started");
    const codemode = await host((command) => {
      if (command.script?.includes("touch") || command.args.includes("no"))
        throw new Error("Refused by the host: not this one");
      return command;
    });
    try {
      const shell = await codemode.execute(
        `return await demo.run({ command: "touch ${marker}" })`,
      );
      assert.match(shell.error ?? "", /Refused by the host: not this one/);
      assert.equal(existsSync(marker), false);
      const binary = await codemode.execute(
        'return await demo.show({ args: ["no"] })',
      );
      assert.match(binary.error ?? "", /Refused by the host: not this one/);
      const allowed = await codemode.execute(
        'return await demo.run({ command: "echo fine" })',
      );
      assert.equal((allowed.result as ShellResult).output, "fine\n");
    } finally {
      codemode.dispose();
    }
  });

  it("must answer a command, and keep a script a script", async () => {
    const answers: unknown[] = [
      undefined,
      { program: "/bin/sh", args: ["-c"] },
      { program: "/bin/sh", args: ["-c"], env: {} },
    ];
    for (const answer of answers) {
      const codemode = await host((() => answer) as SpawnHook);
      try {
        const run = await codemode.execute(
          'return await demo.run({ command: "echo no" })',
        );
        assert.match(run.error ?? "", /spawnHook must/);
      } finally {
        codemode.dispose();
      }
    }
  });

  it("starts a command as it is given: a script with the host's environment, a binary with the few variables every program gets", async () => {
    process.env.CODEMODE_TEST_SECRET = "leaked";
    process.env.HTTPS_PROXY = "http://proxy.test:3128";
    const seen: SpawnCommand[] = [];
    const codemode = await host((command) => {
      seen.push(command);
      return command;
    });
    try {
      const shell = await codemode.execute(
        'return await demo.run({ command: "echo $CODEMODE_TEST_SECRET $FROM_PLUGIN $FROM_CONNECTION" })',
      );
      assert.equal(
        (shell.result as ShellResult).output,
        "leaked plugin connection\n",
      );
      const binary = await codemode.execute("return await demo.show()");
      const result = binary.result as BinaryResult;
      assert.equal(result.stdout, "args=\nsecret=none\nnamed=yes\nhost=none\n");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.truncated, false);
      // The way out of the network is among those few.
      assert.equal(seen[1].env.HTTPS_PROXY, "http://proxy.test:3128");
      assert.equal(seen[1].env.CODEMODE_TEST_SECRET, undefined);
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.CODEMODE_TEST_SECRET;
      codemode.dispose();
    }
  });
});
