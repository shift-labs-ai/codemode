/**
 * What a run hands back: its result, error and logs within the output
 * limit a host sets, each cut the same way and written whole to a file.
 * The last suite bounds thousands of generated runs and checks what must
 * hold of every one.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { boundRun } from "../core/run-output.js";
import { createPluginAPI } from "../plugin/api.js";
import { Codemode } from "../sdk.js";
import { countLines } from "../utils/output-limit.js";
import { randomText, randomValue, seeded } from "./helpers/fuzz.js";

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
const bound = (result: unknown, outputDir = tmp) =>
  boundRun({ result, logs: [] }, limit, outputDir);
const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

describe("a result within the output limit", () => {
  it("is itself when it fits, whatever it is", () => {
    for (const result of ["text", 5, null, undefined, { rows: [1, 2] }])
      assert.deepEqual(bound(result), { result, logs: [] });
  });

  it("is the last lines of a string, and a line that names the file with all of it", () => {
    const whole = numbered(100);
    const { result, truncated, fullResultPath } = bound(whole);
    assert.equal(truncated, true);
    assert.ok(fullResultPath);
    assert.equal(dirname(fullResultPath), tmp);
    assert.match(fullResultPath, /codemode-result-[0-9a-f]{16}\.txt$/);
    assert.equal(readFileSync(fullResultPath, "utf8"), whole);
    assert.equal(statSync(fullResultPath).mode & 0o777, 0o600);
    // Eighteen lines, and two for the closing, are the twenty the limit allows.
    assert.equal(
      result,
      `${whole.split("\n").slice(-18).join("\n")}\n\n[Showing lines 83-100 of 100 (791B in all). Full output: ${fullResultPath}]`,
    );
  });

  it("keeps its shape when cutting one string in it is enough", () => {
    const whole = {
      output: `${"x".repeat(60)}\n`.repeat(100),
      exitCode: 3,
      truncated: false,
    };
    const { result, truncated, fullResultPath } = bound(whole);
    assert.equal(truncated, true);
    const cut = result as typeof whole;
    assert.deepEqual([cut.exitCode, cut.truncated], [3, false]);
    assert.match(
      cut.output,
      /^(x{60}\n)+\n\[Showing lines \d+-100 of 100 \(6\.0KB in all\)\. Full output: .*codemode-result-[0-9a-f]{16}\.json\]$/,
    );
    assert.ok(bytesOf(JSON.stringify(cut, null, 2)) <= limit.bytes);
    assert.ok(countLines(cut.output) <= limit.lines);
    assert.deepEqual(
      JSON.parse(readFileSync(fullResultPath as string, "utf8")),
      whole,
    );
  });

  it("holds a string in a value to the line limit by itself", () => {
    const { result, truncated } = bound({ log: numbered(50), ok: true });
    assert.equal(truncated, true);
    const cut = result as { log: string; ok: boolean };
    assert.equal(cut.ok, true);
    assert.match(
      cut.log,
      /^line 33\n[\s\S]*line 50\n\n\[Showing lines 33-50 of 50 /,
    );
  });

  it("is the first lines of its JSON when cutting strings is not enough", () => {
    const whole = { rows: Array.from({ length: 300 }, (_, id) => ({ id })) };
    const { result, truncated, fullResultPath } = bound(whole);
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
    const { result, truncated, fullResultPath } = bound(
      numbered(100),
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
    const run = { result: null, error: "short", logs: ["[log] a", "[log] b"] };
    assert.deepEqual(boundRun(run, limit, tmp), run);
  });

  it("are their last lines, and a line that names the file with all of them", () => {
    const { error, logs, result, truncated } = boundRun(
      { result: null, error: numbered(100), logs: numbered(100).split("\n") },
      limit,
      tmp,
    );
    assert.deepEqual([result, truncated], [null, undefined]);
    assert.match(
      error ?? "",
      /^line 83\n[\s\S]*line 100\n\n\[Showing lines 83-100 of 100 .* Full output: .*codemode-error-[0-9a-f]{16}\.txt\]$/,
    );
    assert.equal(logs.length, 20);
    assert.deepEqual(logs.slice(0, 2), ["line 83", "line 84"]);
    assert.match(
      logs[19],
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
    assert.ok(bytesOf(JSON.stringify(cut, null, 2)) <= 51_200);
    assert.match(
      cut.text,
      /\[Showing the last .* of line 1 \(390\.6KB in all\)\./,
    );
    assert.equal(statSync(fullResultPath as string).size > 400_000, true);
  });

  it("takes a limit for the instance, for one run, or none", async () => {
    const code = `return "x".repeat(5000)`;
    const set = codemode({ outputLimit: { bytes: 1_024 } });
    const forInstance = await set.execute(code);
    assert.equal(forInstance.truncated, true);
    assert.ok(bytesOf(forInstance.result as string) <= 1_024);
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
    assert.equal(logs.length, 10);
    assert.equal(logs[7], "[log] entry 50");
    assert.match(logs[9], /^\[Showing lines 43-50 of 50 /);
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

describe("every run bounded to the output limit", () => {
  const CLOSING =
    /\n\n\[Showing [^\n]* \([\d.]+(B|KB|MB) in all\)\.( Full output: [^\n]+)?\]$/;
  const render = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];

  it("is within the limit, keeps the whole in a file, and is not cut twice", () => {
    for (let seed = 1; seed <= 1_500; seed++) {
      const random = seeded(seed);
      const limit = {
        lines: random.pick([3, 4, 5, 20, 200, 2000]),
        bytes: random.pick([1024, 1100, 2000, 5000, 51_200]),
      };
      const where = `seed ${seed}, ${JSON.stringify(limit)}`;
      const value = random.chance(0.3)
        ? randomText(random, 300)
        : randomValue(random, 3);
      const logs = Array.from({ length: random.int(0, 80) }, () =>
        randomText(random, 12),
      );
      const error = random.chance(0.3) ? randomText(random, 200) : undefined;
      const fits = (text: string) =>
        bytesOf(text) <= limit.bytes && countLines(text) <= limit.lines;

      const run = boundRun(
        error === undefined
          ? { result: value, logs }
          : { result: null, error, logs },
        limit,
        tmp,
      );
      assert.ok(fits(run.logs.join("\n")), `logs: ${where}`);
      if (run.logs !== logs)
        assert.match(`\n\n${run.logs.at(-1)}`, CLOSING, `logs: ${where}`);
      if (error !== undefined) {
        assert.ok(fits(run.error as string), `error: ${where}`);
        assert.deepEqual([run.result, run.truncated], [null, undefined], where);
        continue;
      }
      if (!run.truncated) {
        assert.deepEqual(run.result, value, where);
        assert.equal(run.fullResultPath, undefined, where);
        if (value !== null) assert.ok(fits(render(value)), where);
        continue;
      }
      const shown = render(run.result);
      assert.ok(fits(shown), `result: ${where}`);
      assert.ok(
        strings(run.result).every((text) => countLines(text) <= limit.lines),
        `a string over the line limit: ${where}`,
      );
      assert.ok(
        strings(run.result).some((text) => CLOSING.test(text)),
        `no closing line: ${where}`,
      );
      assert.ok(
        !shown.includes("\uFFFD") || render(value).includes("\uFFFD"),
        `a character was cut in two: ${where}`,
      );
      assert.equal(
        readFileSync(run.fullResultPath as string, "utf8"),
        render(value),
        `the file is not the whole: ${where}`,
      );
      if (typeof run.result !== "string")
        assert.deepEqual(
          Object.keys(run.result as object),
          Object.keys(value as object),
          `the shape changed: ${where}`,
        );
      assert.equal(
        boundRun({ result: run.result, logs: [] }, limit, tmp).truncated,
        undefined,
        `cut again: ${where}`,
      );
    }
  });
});
