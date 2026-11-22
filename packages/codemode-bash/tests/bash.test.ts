/**
 * The bash package: its one action through a real engine and a real shell,
 * and the package as codemode's package manager loads it.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  Codemode,
  MemoryPackageStore,
  PackageManager,
} from "@shiftlabs/codemode";
import type { ShellResult } from "@shiftlabs/codemode/utils/cli";
import { ends, pidIn } from "../../codemode/src/tests/helpers/processes.js";
import bash, { resolveBash } from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const posix = process.platform === "win32" ? it.skip : it;

let tmp: string;
const instances: Codemode[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codemode-bash-")));
});

afterEach(() => {
  for (const codemode of instances.splice(0)) codemode.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

function codemode(
  config: Record<string, unknown> = {},
  options: Parameters<typeof Codemode.create>[0] = {},
) {
  const created = Codemode.create({
    plugins: [bash],
    connections: [{ name: "bash", plugin: "bash", config }],
    ...options,
  });
  instances.push(created);
  return created;
}

/** Run one command through the engine and answer the action's result. */
async function run(
  input: Record<string, unknown>,
  config: Record<string, unknown> = {},
): Promise<ShellResult> {
  const { result, error } = await codemode(config).execute(
    `return await bash.run(${JSON.stringify(input)})`,
  );
  assert.equal(error, undefined);
  return result as ShellResult;
}

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
    const { result } = await codemode({ cwd: tmp }).execute(`
      await bash.run({ command: "cd / && export KEPT=1" });
      return (await bash.run({ command: 'pwd; echo "kept=$KEPT"' })).output;
    `);
    assert.equal(result, `${tmp}\nkept=\n`);
  });

  posix(
    "runs in the connection's directory, or the call's within it",
    async () => {
      mkdirSync(join(tmp, "inner"));
      assert.equal(
        (await run({ command: "pwd" }, { cwd: tmp })).output,
        `${tmp}\n`,
      );
      assert.equal(
        (await run({ command: "pwd", cwd: "inner" }, { cwd: tmp })).output,
        `${join(tmp, "inner")}\n`,
      );
      const { error } = await codemode({ cwd: tmp }).execute(
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
      const pidFile = join(tmp, "pid");
      const { error } = await codemode().execute(
        `return await bash.run({ command: "sleep 30 & echo $! > ${pidFile}; wait" })`,
        { timeoutMs: 1_500 },
      );
      assert.match(error ?? "", /timed out/);
      assert.equal(await ends(await pidIn(pidFile)), true);
    },
  );

  posix(
    "keeps output past the limit in the host's output directory",
    async () => {
      const outputDir = join(tmp, "outbox");
      const { result, error } = await codemode({}, { outputDir }).execute(
        `return await bash.run({ command: "head -c 1500000 /dev/zero | tr '\\\\0' a; echo END" })`,
      );
      assert.equal(error, undefined);
      const found = result as ShellResult;
      assert.equal(found.truncated, true);
      assert.ok(found.output.endsWith("END\n"));
      assert.ok(found.fullOutputPath);
      assert.equal(dirname(found.fullOutputPath), outputDir);
      assert.match(found.fullOutputPath, /codemode-bash-[0-9a-f]{16}\.log$/);
      assert.equal(statSync(found.fullOutputPath).size, 1_500_004);
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
      () => resolveBash(join(tmp, "no-such-shell")),
      /bash: no shell at /,
    );
  });
});

describe("the package", () => {
  it("loads through the package manager as one plugin named bash", async () => {
    const packages = new PackageManager({
      roots: { user: join(tmp, "user") },
      store: new MemoryPackageStore({ user: [PACKAGE] }),
    });
    // The package needs a codemode after 0.46.0, and the workspace's carries
    // its last release's version until the next one: that warning is right.
    const beyondPeer = (problems: Array<{ code: string }>) =>
      problems.filter((problem) => problem.code !== "peer_unsatisfied");
    const report = await packages.inspect(await packages.fetch(PACKAGE));
    assert.deepEqual(beyondPeer(report.problems), []);
    assert.equal(report.name, "@shiftlabs/codemode-bash");
    assert.equal(report.plugins[0].version, report.version);
    assert.deepEqual(
      report.plugins.map(({ name, actions, write }) => [name, actions, write]),
      [["bash", 1, 1]],
    );
    const { plugins, problems } = await packages.load();
    assert.deepEqual(beyondPeer(problems), []);
    assert.equal(
      plugins[0].sourceInfo?.owner,
      `local:${PACKAGE.replace(/\/$/, "")}`,
    );
  });
});
