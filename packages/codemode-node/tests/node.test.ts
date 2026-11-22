/**
 * The node package: its one action through a real engine and a real
 * Node.js, and the package as codemode's package manager loads it.
 */

import assert from "node:assert/strict";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commandPath, type ShellResult } from "@shiftlabs/codemode/utils/cli";
import { ends, pidIn } from "../../codemode/src/tests/helpers/processes.js";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import node, { resolveNode } from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const installed = commandPath("node") as string;

const harness = pluginHarness(node, "node");
const codemode = harness.codemode;
const run = (
  input: Record<string, unknown>,
  config?: Record<string, unknown>,
) => harness.call<ShellResult>("run", input, config);

describe("node.run", () => {
  it("returns what a script wrote and its exit code", async () => {
    const result = await run({
      command: 'console.log("hello"); console.error("problem")',
    });
    assert.deepEqual(result.output.trim().split("\n").sort(), [
      "hello",
      "problem",
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
  });

  it("runs a script that requires, and one that imports and awaits", async () => {
    const required = await run({
      command: 'console.log(require("node:path").join("a", "b"))',
    });
    assert.equal(required.output, `${join("a", "b")}\n`);
    const imported = await run({
      command:
        'import { basename } from "node:path"; console.log(basename(await Promise.resolve("/x/y.txt")))',
    });
    assert.equal(imported.output, "y.txt\n");
  });

  it("returns the exit code of a script that exits or throws", async () => {
    assert.equal((await run({ command: "process.exit(3)" })).exitCode, 3);
    const thrown = await run({ command: 'throw new Error("boom")' });
    assert.equal(thrown.exitCode, 1);
    assert.match(thrown.output, /Error: boom/);
    const unparsed = await run({ command: "this is not javascript" });
    assert.equal(unparsed.exitCode, 1);
    assert.match(unparsed.output, /SyntaxError/);
  });

  it("starts each call afresh", async () => {
    const { result, error } = await codemode().execute(`
      await node.run({ command: "globalThis.kept = 1" });
      return (await node.run({ command: "console.log(typeof globalThis.kept)" })).output;
    `);
    assert.equal(error, undefined);
    assert.equal(result, "undefined\n");
  });

  it("runs in the connection's directory, or the call's within it", async () => {
    mkdirSync(join(harness.tmp, "inner"));
    const where = { command: "console.log(process.cwd())" };
    assert.equal(
      (await run(where, { cwd: harness.tmp })).output,
      `${harness.tmp}\n`,
    );
    assert.equal(
      (await run({ ...where, cwd: "inner" }, { cwd: harness.tmp })).output,
      `${join(harness.tmp, "inner")}\n`,
    );
  });

  it("rejects a script that outlives its timeout, with what it wrote", async () => {
    const { error } = await codemode().execute(
      `return await node.run({ command: 'console.log("started"); setTimeout(() => {}, 60000)', timeoutMs: 2000 })`,
    );
    assert.match(error ?? "", /started\n\nCommand timed out after 2 seconds/);
  });

  it("ends the script when the run ends first", async () => {
    const pidFile = join(harness.tmp, "pid");
    const { error } = await codemode().execute(
      `return await node.run({ command: 'require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)' })`,
      { timeoutMs: 2_000 },
    );
    assert.match(error ?? "", /timed out/);
    assert.equal(await ends(await pidIn(pidFile)), true);
  });

  it("keeps output past the limit in the host's output directory", async () => {
    const outputDir = join(harness.tmp, "outbox");
    const { result, error } = await codemode({}, { outputDir }).execute(
      `return await node.run({ command: 'process.stdout.write("a".repeat(1500000) + "END")' })`,
    );
    assert.equal(error, undefined);
    const found = result as ShellResult;
    assert.equal(found.truncated, true);
    assert.ok(found.output.endsWith("END"));
    assert.ok(found.fullOutputPath);
    assert.equal(dirname(found.fullOutputPath), outputDir);
    assert.match(found.fullOutputPath, /codemode-node-[0-9a-f]{16}\.log$/);
    assert.equal(statSync(found.fullOutputPath).size, 1_500_003);
  });

  it("refuses input that is not a script", async () => {
    for (const input of [{}, { command: "" }, { code: "1" }]) {
      const { error } = await codemode().execute(
        `return await node.run(${JSON.stringify(input)})`,
      );
      assert.match(error ?? "", /Invalid input for node\.run/);
    }
  });
});

describe("the Node.js node.run uses", () => {
  it("is the one the connection names", async () => {
    const result = await run(
      { command: "console.log(process.execPath)" },
      { shell: installed },
    );
    assert.equal(result.output, `${realpathSync(installed)}\n`);
    assert.deepEqual(resolveNode(installed), {
      program: installed,
      args: ["-"],
      scriptOnStdin: true,
    });
  });

  it("is refused when it is not there", () => {
    assert.throws(
      () => resolveNode(join(harness.tmp, "no-such-node")),
      /node: no Node\.js at /,
    );
  });

  it("is the one codemode runs in when none is on PATH, where that is Node.js", () => {
    const path = process.env.PATH;
    process.env.PATH = harness.tmp;
    try {
      if ("bun" in process.versions)
        assert.throws(() => resolveNode(), /node: no Node\.js found/);
      else assert.equal(resolveNode().program, process.execPath);
    } finally {
      process.env.PATH = path;
    }
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-node",
  plugin: "node",
  actions: 1,
  write: 1,
});
