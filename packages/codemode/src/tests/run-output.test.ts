/**
 * What a run hands back: its result, error and logs within the output
 * limit a host sets, each cut the same way and written whole to a file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  boundError,
  boundLogs,
  boundResult,
  resolveOutputLimit,
} from "../core/run-output.js";
import { createPluginAPI } from "../plugin/api.js";
import { Codemode } from "../sdk.js";
import { OUTPUT_LIMIT } from "../utils/output-files.js";

let tmp: string;
const instances: Codemode[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codemode-run-output-"));
});

afterEach(() => {
  for (const codemode of instances.splice(0)) codemode.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A plugin whose action answers a text of the size it is asked for. */
function big() {
  const { api, resolve } = createPluginAPI("big");
  api.registerAction("text", {
    execute: (input) => "x".repeat((input as { bytes: number }).bytes),
  });
  return resolve();
}

function codemode(options: Parameters<typeof Codemode.create>[0] = {}) {
  const created = Codemode.create({
    plugins: [big()],
    outputDir: tmp,
    ...options,
  });
  instances.push(created);
  return created;
}

const limit = { lines: 20, bytes: 2_000 };
const numbered = (count: number) =>
  Array.from({ length: count }, (_, n) => `line ${n + 1}`).join("\n");

describe("the limit a setting stands for", () => {
  it("is 2,000 lines and 50 KB unless a host says otherwise", () => {
    assert.deepEqual(resolveOutputLimit(undefined), OUTPUT_LIMIT);
    assert.deepEqual(resolveOutputLimit({}), { lines: 2000, bytes: 51_200 });
    assert.deepEqual(resolveOutputLimit({ lines: 5 }), {
      lines: 5,
      bytes: 51_200,
    });
    assert.equal(resolveOutputLimit(false), undefined);
  });

  it("is refused when it is not a size", () => {
    for (const setting of [{ bytes: 0 }, { lines: -1 }, { bytes: 1.5 }])
      assert.throws(() => resolveOutputLimit(setting), /Invalid outputLimit/);
  });
});

describe("a result within the output limit", () => {
  it("is itself when it fits, whatever it is", () => {
    for (const result of ["text", 5, null, undefined, { rows: [1, 2] }])
      assert.deepEqual(boundResult(result, limit, tmp), { result });
  });

  it("is the last lines of a string, and a line that names the file with all of it", () => {
    const whole = numbered(100);
    const { result, truncated, fullResultPath } = boundResult(
      whole,
      limit,
      tmp,
    );
    assert.equal(truncated, true);
    assert.ok(fullResultPath);
    assert.equal(dirname(fullResultPath), tmp);
    assert.match(fullResultPath, /codemode-result-[0-9a-f]{16}\.txt$/);
    assert.equal(readFileSync(fullResultPath, "utf8"), whole);
    assert.equal(statSync(fullResultPath).mode & 0o777, 0o600);
    // Eighteen lines, and two for the note, are the twenty the limit allows.
    assert.equal(
      result,
      `${numbered(100).split("\n").slice(-18).join("\n")}\n\n[Showing lines 83-100 of 100 (791B in all). Full output: ${fullResultPath}]`,
    );
  });

  it("keeps its shape when one string in it is what makes it too large", () => {
    const whole = {
      output: `${numbered(500)}\n`,
      exitCode: 3,
      truncated: false,
    };
    const { result, truncated, fullResultPath } = boundResult(
      whole,
      limit,
      tmp,
    );
    assert.equal(truncated, true);
    const cut = result as typeof whole;
    assert.deepEqual([cut.exitCode, cut.truncated], [3, false]);
    assert.match(
      cut.output,
      /\nline 500\n\n\[Showing lines \d+-500 of 500 \(.*in all\)\. Full output: .*codemode-result-[0-9a-f]{16}\.json\]$/,
    );
    const asText = JSON.stringify(cut, null, 2);
    assert.ok(Buffer.byteLength(asText) <= limit.bytes);
    assert.ok(cut.output.split("\n").length <= limit.lines);
    assert.deepEqual(
      JSON.parse(readFileSync(fullResultPath as string, "utf8")),
      whole,
    );
  });

  it("is the first lines of its JSON when no one string accounts for it", () => {
    const whole = { rows: Array.from({ length: 300 }, (_, id) => ({ id })) };
    const { result, truncated, fullResultPath } = boundResult(
      whole,
      limit,
      tmp,
    );
    assert.equal(truncated, true);
    assert.equal(typeof result, "string");
    assert.ok((result as string).startsWith('{\n  "rows": [\n    {\n'));
    assert.match(
      result as string,
      /\n\n\[Showing lines 1-18 of 904 \(.*in all\)\. Full output: .*\.json\]$/,
    );
    assert.equal(
      JSON.parse(readFileSync(fullResultPath as string, "utf8")).rows.length,
      300,
    );
  });

  it("is still cut where the file cannot be written, and names none", () => {
    const { result, truncated, fullResultPath } = boundResult(
      numbered(100),
      limit,
      join(tmp, "missing"),
    );
    assert.equal(truncated, true);
    assert.equal(fullResultPath, undefined);
    assert.match(
      result as string,
      /\[Showing lines 83-100 of 100 \(791B in all\)\.\]$/,
    );
  });
});

describe("an error and logs within the output limit", () => {
  it("are themselves when they fit", () => {
    assert.equal(boundError("short", limit, tmp), "short");
    assert.deepEqual(boundLogs(["[log] a", "[log] b"], limit, tmp), [
      "[log] a",
      "[log] b",
    ]);
  });

  it("are their last lines, and a line that names the file with all of them", () => {
    const error = boundError(numbered(100), limit, tmp);
    assert.match(
      error,
      /^line 83\n[\s\S]*line 100\n\n\[Showing lines 83-100 of 100 .* Full output: .*codemode-error-[0-9a-f]{16}\.txt\]$/,
    );
    const logs = boundLogs(numbered(100).split("\n"), limit, tmp);
    assert.equal(logs.length, 19);
    assert.deepEqual(logs.slice(0, 2), ["line 83", "line 84"]);
    assert.match(
      logs[18],
      /^\[Showing lines 83-100 of 100 .* Full output: .*codemode-logs-[0-9a-f]{16}\.log\]$/,
    );
  });
});

describe("a run", () => {
  it("hands back at most 50 KB by default, and code inside it works with all of a value", async () => {
    const { result, truncated, fullResultPath, error } =
      await codemode().execute(`
        const text = await big.text({ bytes: 400000 });
        return { length: text.length, text };
      `);
    assert.equal(error, undefined);
    assert.equal(truncated, true);
    const cut = result as { length: number; text: string };
    assert.equal(cut.length, 400_000);
    assert.ok(Buffer.byteLength(JSON.stringify(cut, null, 2)) <= 51_200);
    assert.match(
      cut.text,
      /\[Showing the last .* of line 1 \(390\.6KB in all\)\./,
    );
    assert.equal(statSync(fullResultPath as string).size > 400_000, true);
  });

  it("takes a limit for the instance, for one run, or none", async () => {
    const code = `return "x".repeat(5000)`;
    const set = codemode({ outputLimit: { bytes: 1_000 } });
    const forInstance = await set.execute(code);
    assert.equal(forInstance.truncated, true);
    assert.ok(Buffer.byteLength(forInstance.result as string) <= 1_000);
    const forRun = await set.execute(code, { outputLimit: { bytes: 6_000 } });
    assert.deepEqual(
      [forRun.truncated, (forRun.result as string).length],
      [undefined, 5_000],
    );
    const whole = await codemode({ outputLimit: false }).execute(
      `return "x".repeat(200000)`,
    );
    assert.deepEqual(
      [whole.truncated, (whole.result as string).length],
      [undefined, 200_000],
    );
  });

  it("bounds what it logged and why it failed", async () => {
    const { logs, error } = await codemode({
      outputLimit: { lines: 10 },
    }).execute(`
      for (let i = 1; i <= 50; i++) console.log("entry " + i);
      throw new Error(Array.from({ length: 50 }, (_, i) => "why " + (i + 1)).join("\\n"));
    `);
    assert.equal(logs.length, 9);
    assert.equal(logs[7], "[log] entry 50");
    assert.match(logs[8], /^\[Showing lines 43-50 of 50 /);
    assert.match(
      error ?? "",
      /why 50\n[\s\S]*\n\n\[Showing lines \d+-\d+ of \d+ /,
    );
    assert.ok((error ?? "").split("\n").length <= 10);
  });

  it("refuses a limit that is not one", async () => {
    const { error } = await codemode({ outputLimit: { bytes: 0 } }).execute(
      "return 1",
    );
    assert.match(error ?? "", /Invalid outputLimit/);
  });
});
