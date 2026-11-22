/**
 * The node package: its actions through a real engine, its requests against
 * a server of this file's own, and the package as codemode's package
 * manager loads it.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import node from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const harness = pluginHarness(node, "node");
const codemode = harness.codemode;

/** Run code that uses `node`, and answer what it returns. */
async function run<T>(
  code: string,
  config?: Record<string, unknown>,
): Promise<T> {
  const { result, error } = await codemode(config).execute(code);
  assert.equal(error, undefined);
  return result as T;
}

interface Answer {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  bodyPath?: string;
  bytes: number;
}

describe("node.fs", () => {
  it("writes, reads and describes files", async () => {
    const file = JSON.stringify(join(harness.tmp, "notes.txt"));
    const found = await run<{
      text: string;
      base64: string;
      exists: boolean;
      stat: { isFile: boolean; size: number };
      names: string[];
      gone: boolean;
    }>(`
      await node.fs.writeFile({ path: ${file}, data: "hel" });
      await node.fs.appendFile({ path: ${file}, data: "lo" });
      const text = await node.fs.readFile({ path: ${file} });
      const base64 = await node.fs.readFile({ path: ${file}, encoding: "base64" });
      const exists = await node.fs.exists({ path: ${file} });
      const stat = await node.fs.stat({ path: ${file} });
      const names = await node.fs.readdir({ path: ${JSON.stringify(harness.tmp)} });
      await node.fs.rm({ path: ${file} });
      return { text, base64, exists, stat, names, gone: !(await node.fs.exists({ path: ${file} })) };
    `);
    assert.equal(found.text, "hello");
    assert.equal(found.base64, "aGVsbG8=");
    assert.equal(found.exists, true);
    assert.equal(found.stat.isFile, true);
    assert.equal(found.stat.size, 5);
    assert.deepEqual(found.names, ["notes.txt"]);
    assert.equal(found.gone, true);
  });

  it("resolves a relative path from the connection's directory", async () => {
    mkdirSync(join(harness.tmp, "inner"));
    const found = await run<{ written: string; cwd: string; resolved: string }>(
      `
      const { path } = await node.fs.writeFile({ path: "inner/a.txt", data: "x" });
      return {
        written: path,
        cwd: await node.process.cwd(),
        resolved: await node.path.resolve({ segments: ["inner", "..", "b"] }),
      };
    `,
      { cwd: harness.tmp },
    );
    assert.deepEqual(found, {
      written: join(harness.tmp, "inner", "a.txt"),
      cwd: harness.tmp,
      resolved: join(harness.tmp, "b"),
    });
    assert.equal(
      readFileSync(join(harness.tmp, "inner", "a.txt"), "utf8"),
      "x",
    );
  });

  it("refuses to read a file larger than maxBytes, with its size", async () => {
    const file = join(harness.tmp, "big.txt");
    writeFileSync(file, "x".repeat(2_000));
    const { error } = await codemode().execute(
      `return await node.fs.readFile({ path: ${JSON.stringify(file)}, maxBytes: 1000 })`,
    );
    assert.match(error ?? "", /big\.txt is 2000 bytes, over the limit of 1000/);
    assert.equal(
      await run(
        `return (await node.fs.readFile({ path: ${JSON.stringify(file)}, maxBytes: 2000 })).length`,
      ),
      2_000,
    );
  });

  it("refuses input an action does not take", async () => {
    for (const call of [
      `node.fs.readFile({})`,
      `node.fs.readFile({ path: "a", encoding: "klingon" })`,
      `node.fs.writeFile({ path: "a", data: "x", mode: 511 })`,
      `node.path.join(["a", "b"])`,
      `node.crypto.randomBytes({ size: 0 })`,
    ]) {
      const { error } = await codemode().execute(`return await ${call}`);
      assert.match(error ?? "", /Invalid input for node\./, call);
    }
  });
});

describe("the node plugin's other actions", () => {
  it("work with paths", async () => {
    const found = await run<{
      joined: string;
      base: string;
      absolute: boolean;
      relative: string;
    }>(`
      const joined = await node.path.join({ segments: ["a", "b", "c.txt"] });
      const base = await node.path.basename({ path: joined, suffix: ".txt" });
      const absolute = await node.path.isAbsolute({ path: joined });
      const relative = await node.path.relative({ from: "a", to: "a/b" });
      return { joined, base, absolute, relative };
    `);
    assert.deepEqual(found, {
      joined: join("a", "b", "c.txt"),
      base: "c",
      absolute: false,
      relative: "b",
    });
  });

  it("read system facts and the environment", async () => {
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

  it("hash and make random values", async () => {
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

  it("run no commands", async () => {
    const names = await run<string[]>(`return actions.list("node")`);
    assert.equal(names.length, 36);
    assert.deepEqual(
      names.filter((name) => /exec/i.test(name)),
      [],
    );
  });
});

describe("node.fetch", () => {
  let server: Server;
  let origin: string;
  /** Requests the server is still answering, and whether each was dropped by its client. */
  const hanging: { closed: Promise<void> }[] = [];

  before(async () => {
    server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      if (pathname === "/json") {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ method: request.method, ok: true }));
      } else if (pathname === "/text") {
        response.setHeader("content-type", "text/plain");
        response.end("héllo");
      } else if (pathname === "/image.png") {
        response.setHeader("content-type", "image/png");
        response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]));
      } else if (pathname === "/large") {
        response.setHeader("content-type", "text/plain");
        response.end("a".repeat(50_000));
      } else if (pathname === "/hang") {
        response.setHeader("content-type", "text/plain");
        response.write("started");
        hanging.push({
          closed: new Promise((resolve) => response.on("close", resolve)),
        });
      } else {
        response.statusCode = 404;
        response.end("nothing here");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const get = (path: string, more = "", options = {}) =>
    codemode({}, options).execute(
      `return await node.fetch({ url: "${origin}${path}"${more} })`,
    );

  it("returns a text body, parsed when it is JSON", async () => {
    const json = (await get("/json", `, method: "POST", body: "{}"`))
      .result as Answer;
    assert.equal(json.status, 200);
    assert.deepEqual(json.body, { method: "POST", ok: true });
    assert.equal(json.bodyPath, undefined);
    const text = (await get("/text")).result as Answer;
    assert.equal(text.body, "héllo");
    assert.equal(text.bytes, 6);
    const missing = (await get("/missing")).result as Answer;
    assert.deepEqual(
      [missing.ok, missing.status, missing.body],
      [false, 404, "nothing here"],
    );
  });

  it("writes a body that is not text to a file", async () => {
    const outputDir = join(harness.tmp, "outbox");
    const { result, error } = await get("/image.png", "", { outputDir });
    assert.equal(error, undefined);
    const found = result as Answer;
    assert.equal(found.body, undefined);
    assert.ok(found.bodyPath);
    assert.equal(dirname(found.bodyPath), outputDir);
    assert.match(found.bodyPath, /codemode-node-[0-9a-f]{16}\.png$/);
    assert.deepEqual(
      [...readFileSync(found.bodyPath)],
      [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00],
    );
    assert.equal(statSync(found.bodyPath).mode & 0o777, 0o600);
  });

  it("writes a body past maxBytes to a file, all of it", async () => {
    const outputDir = join(harness.tmp, "outbox");
    const { result, error } = await get("/large", ", maxBytes: 1000", {
      outputDir,
    });
    assert.equal(error, undefined);
    const found = result as Answer;
    assert.equal(found.body, undefined);
    assert.equal(found.bytes, 50_000);
    assert.match(found.bodyPath ?? "", /codemode-node-[0-9a-f]{16}\.txt$/);
    assert.equal(statSync(found.bodyPath as string).size, 50_000);
  });

  it("gives up after timeoutMs", async () => {
    const { error } = await get("/hang", ", timeoutMs: 1000");
    assert.match(error ?? "", /timed out|timeout|aborted/i);
    await hanging.at(-1)?.closed;
  });

  it("ends its request when the run ends", async () => {
    const { error } = await codemode().execute(
      `return await node.fetch({ url: "${origin}/hang" })`,
      { timeoutMs: 1_000 },
    );
    assert.match(error ?? "", /timed out/);
    // Resolves only once the client has dropped the connection.
    await hanging.at(-1)?.closed;
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-node",
  plugin: "node",
  actions: 36,
  write: 8,
});
