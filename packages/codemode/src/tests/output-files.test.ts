/**
 * Output files: where codemode and its plugins write what a caller was not
 * handed in full, and how a host says where that is.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createPluginAPI } from "../plugin/api.js";
import { Codemode } from "../sdk.js";
import { OutputFileWriter, writeOutputFile } from "../utils/output-files.js";

let tmp: string;
const instances: Codemode[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codemode-output-"));
});

afterEach(() => {
  for (const codemode of instances.splice(0)) codemode.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A plugin whose actions answer what the host handed them about output. */
function probe() {
  const { api, resolve } = createPluginAPI("probe");
  api.registerAction("outputDir", {
    execute: (_input, ctx) => ctx.outputDir ?? null,
  });
  api.registerAction("maxOutputBytes", {
    execute: (_input, ctx) => ctx.maxOutputBytes ?? null,
  });
  return resolve();
}

function codemode(options: Parameters<typeof Codemode.create>[0] = {}) {
  const created = Codemode.create({ plugins: [probe()], ...options });
  instances.push(created);
  return created;
}

describe("an output file", () => {
  it("is new, private, and in the directory named", () => {
    const dir = tmp;
    const first = writeOutputFile("report", ".json", "{}", dir);
    const second = writeOutputFile("report", ".json", "[]", dir);
    assert.notEqual(first, second);
    assert.equal(dirname(first), dir);
    assert.match(first, /report-[0-9a-f]{16}\.json$/);
    assert.equal(readFileSync(second, "utf8"), "[]");
    if (process.platform !== "win32")
      assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.throws(
      () => writeOutputFile("report", ".json", "{}", join(tmp, "missing")),
      { code: "ENOENT" },
    );
  });

  it("takes output that arrives in parts", async () => {
    const file = new OutputFileWriter("log", ".log", tmp);
    assert.equal(file.write("one "), true);
    file.write(Buffer.from("two"));
    const path = await file.close();
    assert.ok(path);
    assert.equal(dirname(path), tmp);
    assert.match(path, /log-[0-9a-f]{16}\.log$/);
    assert.equal(readFileSync(path, "utf8"), "one two");
    if (process.platform !== "win32")
      assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("says when it is behind, and takes more once it has caught up", async () => {
    const file = new OutputFileWriter("log", ".log", tmp);
    const part = Buffer.alloc(1_000_000, "a");
    let behind = false;
    for (let sent = 0; sent < 8; sent++)
      if (!file.write(part)) {
        behind = true;
        await file.drained();
      }
    assert.equal(behind, true);
    assert.equal(statSync((await file.close()) as string).size, 8_000_000);
  });

  it("goes on without a file that cannot be written, and answers no path", async () => {
    const file = new OutputFileWriter("log", ".log", join(tmp, "missing"));
    assert.equal(file.write("dropped"), true);
    await file.drained();
    assert.equal(await file.close(), undefined);
  });

  it("is removed when what it was for did not come to an end", async () => {
    const file = new OutputFileWriter("log", ".log", tmp);
    file.write("half");
    await file.discard();
    assert.deepEqual(readdirSync(tmp), []);
  });

  it("refuses a name that would leave its directory", () => {
    for (const [prefix, extension] of [
      ["../escape", ".txt"],
      ["a/b", ".txt"],
      [".hidden", ".txt"],
      ["", ".txt"],
      ["ok", "/../x"],
      ["ok", "txt"],
    ])
      assert.throws(
        () => writeOutputFile(prefix, extension, "x", tmp),
        /Invalid output file/,
      );
    assert.deepEqual(readdirSync(tmp), []);
  });
});

describe("the directory a host names for output", () => {
  it("reaches every action as ctx.outputDir, for the instance or for one run", async () => {
    const run = "return await probe.outputDir()";
    assert.equal((await codemode().execute(run)).result, null);
    const hosted = codemode({ outputDir: join(tmp, "instance") });
    assert.equal((await hosted.execute(run)).result, join(tmp, "instance"));
    // The engine makes the directory a host names.
    assert.equal(statSync(join(tmp, "instance")).isDirectory(), true);
    assert.equal(
      (await hosted.execute(run, { outputDir: join(tmp, "run") })).result,
      join(tmp, "run"),
    );
  });

  it("is refused when it is not a path", async () => {
    for (const outputDir of ["", 5 as unknown as string]) {
      const { error } = await codemode({ outputDir }).execute("return 1");
      assert.match(error ?? "", /Invalid outputDir/);
    }
  });

  it("comes from a project's config.json, from where the project is", async () => {
    const project = join(tmp, "project");
    mkdirSync(join(project, ".codemode"), { recursive: true });
    writeFileSync(
      join(project, ".codemode", "config.json"),
      JSON.stringify({
        connections: [],
        outputDir: "outbox",
        outputLimit: { bytes: 1024 },
      }),
    );
    const loaded = await Codemode.fromProject(project, {
      builtinDir: join(tmp, "no-builtins"),
      userDir: join(tmp, "home"),
      packages: false,
      mcp: false,
    });
    assert.ok(loaded);
    instances.push(loaded);
    const { truncated, fullResultPath } = await loaded.execute(
      `return "x".repeat(5000)`,
    );
    assert.equal(truncated, true);
    assert.equal(dirname(fullResultPath as string), join(project, "outbox"));
  });
});

describe("how much a host lets an action hold in memory", () => {
  const run = "return await probe.maxOutputBytes()";

  it("reaches every action as ctx.maxOutputBytes: 8 MiB, or what the instance or one run sets", async () => {
    assert.equal((await codemode().execute(run)).result, 8 * 1024 * 1024);
    const set = codemode({ maxActionOutputBytes: 2_048 });
    assert.equal((await set.execute(run)).result, 2_048);
    assert.equal(
      (await set.execute(run, { maxActionOutputBytes: 4_096 })).result,
      4_096,
    );
  });

  it("is refused when it is not a size, or too small to say anything in", async () => {
    for (const maxActionOutputBytes of [0, 1_023, 1.5, Number.NaN]) {
      const { error } = await codemode({ maxActionOutputBytes }).execute(run);
      assert.match(error ?? "", /Invalid maxActionOutputBytes/);
    }
  });

  it("comes from a project's config.json", async () => {
    const project = join(tmp, "project");
    mkdirSync(join(project, ".codemode"), { recursive: true });
    writeFileSync(
      join(project, ".codemode", "config.json"),
      JSON.stringify({ connections: [], maxActionOutputBytes: 2_048 }),
    );
    const loaded = await Codemode.fromProject(project, {
      builtinDir: join(tmp, "no-builtins"),
      userDir: join(tmp, "home"),
      packages: false,
      mcp: false,
    });
    assert.ok(loaded);
    instances.push(loaded);
    loaded.addPlugin(probe());
    assert.equal((await loaded.execute(run)).result, 2_048);
  });
});
