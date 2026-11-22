/**
 * The node package: its actions through a real engine, and the package as
 * codemode's package manager loads it.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import node from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const harness = pluginHarness(node, "node");

/** Run code that uses `node`, and answer what it returns. */
async function run<T>(code: string): Promise<T> {
  const { result, error } = await harness.codemode().execute(code);
  assert.equal(error, undefined);
  return result as T;
}

describe("the node plugin", () => {
  it("writes, reads and describes files", async () => {
    const file = JSON.stringify(join(harness.tmp, "notes.txt"));
    const found = await run<{
      text: string;
      exists: boolean;
      stat: { isFile: boolean; size: number };
      names: string[];
      gone: boolean;
    }>(`
      await node.fs.writeFile({ path: ${file}, data: "hel" });
      await node.fs.appendFile({ path: ${file}, data: "lo" });
      const text = await node.fs.readFile({ path: ${file} });
      const exists = await node.fs.exists({ path: ${file} });
      const stat = await node.fs.stat({ path: ${file} });
      const names = await node.fs.readdir({ path: ${JSON.stringify(harness.tmp)} });
      await node.fs.rm({ path: ${file} });
      return { text, exists, stat, names, gone: !(await node.fs.exists({ path: ${file} })) };
    `);
    assert.equal(found.text, "hello");
    assert.equal(found.exists, true);
    assert.equal(found.stat.isFile, true);
    assert.equal(found.stat.size, 5);
    assert.deepEqual(found.names, ["notes.txt"]);
    assert.equal(found.gone, true);
  });

  it("works with paths", async () => {
    const found = await run<{
      joined: string;
      base: string;
      absolute: boolean;
    }>(`
      const joined = await node.path.join({ segments: ["a", "b", "c.txt"] });
      const base = await node.path.basename({ path: joined });
      const absolute = await node.path.isAbsolute({ path: joined });
      return { joined, base, absolute };
    `);
    assert.deepEqual(found, {
      joined: join("a", "b", "c.txt"),
      base: "c.txt",
      absolute: false,
    });
  });

  it("reads system facts and the environment", async () => {
    const found = await run<{ platform: string; cwd: string; path: string }>(`
      return {
        platform: await node.os.platform(),
        cwd: await node.process.cwd(),
        path: await node.process.env({ name: "PATH" }),
      };
    `);
    assert.deepEqual(found, {
      platform: process.platform,
      cwd: process.cwd(),
      path: process.env.PATH,
    });
  });

  it("hashes and makes random values", async () => {
    const found = await run<{ hash: string; bytes: string; id: string }>(`
      const hash = await node.crypto.hash({ data: "hello" });
      const bytes = await node.crypto.randomBytes({ size: 4 });
      const id = await node.crypto.randomUUID();
      return { hash, bytes, id };
    `);
    assert.equal(
      found.hash,
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    assert.match(found.bytes, /^[a-f0-9]{8}$/);
    assert.match(found.id, /^[0-9a-f-]{36}$/);
  });

  it("makes an HTTP request", async () => {
    const found = await run<{ ok: boolean; status: number; body: string }>(
      `return await node.fetch({ url: "data:text/plain,hello" })`,
    );
    assert.equal(found.ok, true);
    assert.equal(found.status, 200);
    assert.equal(found.body, "hello");
  });

  it("runs no commands", async () => {
    const names = await run<string[]>(`return actions.list("node")`);
    assert.equal(names.length, 36);
    assert.ok(names.includes("node.fs.readFile"));
    assert.deepEqual(
      names.filter((name) => /exec/i.test(name)),
      [],
    );
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-node",
  plugin: "node",
  actions: 36,
  write: 8,
});
