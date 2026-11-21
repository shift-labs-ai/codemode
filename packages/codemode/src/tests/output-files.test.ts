/**
 * Output files: where codemode and its plugins write what a caller was not
 * handed in full, and how a host says where that is and how much a run may
 * return.
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
import {
  clipText,
  createOutputFileStream,
  writeOutputFile,
} from "../utils/output-files.js";

let tmp: string;
const instances: Codemode[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codemode-output-"));
});

afterEach(() => {
  for (const codemode of instances.splice(0)) codemode.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A plugin whose one action answers the directory it was handed. */
function probe() {
  const { api, resolve } = createPluginAPI("probe");
  api.registerAction("outputDir", {
    execute: (_input, ctx) => ctx.outputDir ?? null,
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
    const { path, stream } = createOutputFileStream("log", ".log", tmp);
    stream.write("one ");
    await new Promise<void>((resolve) => stream.end("two", () => resolve()));
    assert.equal(readFileSync(path, "utf8"), "one two");
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

describe("text clipped to a size", () => {
  it("is itself while it fits, then its start and end around what was left out", () => {
    assert.deepEqual(clipText("short", 5), { text: "short", truncated: false });
    const long = `START${"x".repeat(100)}END`;
    const clipped = clipText(long, 20);
    assert.equal(clipped.truncated, true);
    assert.equal(
      clipped.text,
      "STARTxxxxx\n\n[... 88 bytes omitted ...]\n\nxxxxxxxEND",
    );
  });

  it("is cut between characters", () => {
    const clipped = clipText("é".repeat(100), 21);
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.text.includes("\uFFFD"), false);
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
        maxResultBytes: 50,
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
      `return "x".repeat(500)`,
    );
    assert.equal(truncated, true);
    assert.equal(dirname(fullResultPath as string), join(project, "outbox"));
  });
});

describe("a run's result past the size a host allows", () => {
  const big = `return { rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: "row " + i })) }`;

  it("is returned whole when no limit is set, or when it fits", async () => {
    const unlimited = await codemode().execute(big);
    assert.equal((unlimited.result as { rows: unknown[] }).rows.length, 500);
    assert.equal(unlimited.truncated, undefined);
    const fits = await codemode({ maxResultBytes: 1_000 }).execute(
      "return { ok: true }",
    );
    assert.deepEqual(fits, { result: { ok: true }, logs: [] });
  });

  it("is its start and end, with all of it in a file in the host's directory", async () => {
    const outputDir = join(tmp, "outputs");
    const { result, truncated, fullResultPath, error } = await codemode({
      maxResultBytes: 400,
      outputDir,
    }).execute(big);
    assert.equal(error, undefined);
    assert.equal(truncated, true);
    assert.equal(typeof result, "string");
    assert.ok((result as string).startsWith('{"rows":[{"id":0,'));
    assert.ok((result as string).endsWith('"name":"row 499"}]}'));
    assert.match(result as string, /\[\.\.\. \d+ bytes omitted \.\.\.\]/);
    assert.ok(fullResultPath);
    assert.equal(dirname(fullResultPath), outputDir);
    assert.match(fullResultPath, /codemode-result-[0-9a-f]{16}\.json$/);
    const whole = JSON.parse(readFileSync(fullResultPath, "utf8"));
    assert.equal(whole.rows.length, 500);
    assert.deepEqual(whole.rows[499], { id: 499, name: "row 499" });
  });

  it("keeps a long string as text, and takes a limit for one run", async () => {
    const { result, truncated, fullResultPath } = await codemode({
      outputDir: tmp,
    }).execute(`return "a".repeat(5000) + "END"`, { maxResultBytes: 100 });
    assert.equal(truncated, true);
    assert.ok((result as string).endsWith("END"));
    assert.ok(fullResultPath?.endsWith(".txt"));
    assert.equal(readFileSync(fullResultPath as string, "utf8").length, 5003);
  });

  it("is refused as a setting when it is not a size", async () => {
    for (const maxResultBytes of [0, -1, 1.5, Number.NaN]) {
      const { error } = await codemode({ maxResultBytes }).execute("return 1");
      assert.match(error ?? "", /Invalid maxResultBytes/);
    }
  });
});
