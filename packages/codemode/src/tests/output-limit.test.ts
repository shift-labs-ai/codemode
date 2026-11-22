/**
 * The output limit: the setting a host gives, and the one way a text is
 * cut to it. The last suite cuts thousands of generated texts and checks
 * what must hold of every one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countLines,
  cutText,
  formatSize,
  MIN_OUTPUT_LIMIT,
  OUTPUT_LIMIT,
  resolveOutputLimit,
  withinLimit,
} from "../utils/output-limit.js";
import { assertCutOf } from "./helpers/cut.js";
import { randomText, seeded } from "./helpers/fuzz.js";

const limit = { lines: 6, bytes: 1024 };
const numbered = (count: number) =>
  Array.from({ length: count }, (_, n) => `line ${n + 1}`).join("\n");

describe("the limit a setting stands for", () => {
  it("is 2,000 lines and 50 KB unless a host says otherwise", () => {
    assert.deepEqual(OUTPUT_LIMIT, { lines: 2000, bytes: 51_200 });
    assert.deepEqual(resolveOutputLimit(undefined), OUTPUT_LIMIT);
    assert.deepEqual(resolveOutputLimit({}), OUTPUT_LIMIT);
    assert.deepEqual(resolveOutputLimit({ lines: 5 }), {
      lines: 5,
      bytes: 51_200,
    });
    assert.equal(resolveOutputLimit(false), undefined);
  });

  it("is refused when it is not a size, or too small to say anything in", () => {
    assert.deepEqual(resolveOutputLimit(MIN_OUTPUT_LIMIT), MIN_OUTPUT_LIMIT);
    for (const setting of [
      { bytes: 0 },
      { bytes: 1023 },
      { lines: 2 },
      { lines: -1 },
      { bytes: 1.5 },
      { lines: Number.NaN },
    ])
      assert.throws(() => resolveOutputLimit(setting), /Invalid outputLimit/);
  });
});

describe("a text cut to the output limit", () => {
  it("is itself while it fits", () => {
    assert.deepEqual(cutText("a\nb\n", limit, { keep: "last" }), {
      text: "a\nb\n",
      truncated: false,
    });
  });

  it("keeps whole lines from one end, and closes with the lines they are", () => {
    assert.deepEqual(cutText(numbered(50), limit, { keep: "last" }), {
      text: "line 47\nline 48\nline 49\nline 50\n\n[Showing lines 47-50 of 50 (390B in all).]",
      truncated: true,
    });
    assert.deepEqual(
      cutText(numbered(50), limit, { keep: "first", path: "/tmp/all.txt" }),
      {
        text: "line 1\nline 2\nline 3\nline 4\n\n[Showing lines 1-4 of 50 (390B in all). Full output: /tmp/all.txt]",
        truncated: true,
      },
    );
  });

  it("keeps as many lines as the byte limit allows", () => {
    const text = Array.from({ length: 40 }, () => "x".repeat(99)).join("\n");
    const cut = cutText(text, { lines: 2000, bytes: 1024 }, { keep: "last" });
    // Nine lines of a hundred bytes, beside the closing line, fit in 1,024.
    assert.equal(
      cut.text,
      `${Array(9).fill("x".repeat(99)).join("\n")}\n\n[Showing lines 32-40 of 40 (3.9KB in all).]`,
    );
    assert.ok(Buffer.byteLength(cut.text) <= 1024);
  });

  it("keeps part of a line too long to keep whole, cut between characters", () => {
    const last = cutText(`short\n${"é".repeat(2000)}`, limit, { keep: "last" });
    assert.match(
      last.text,
      /^é+\n\n\[Showing the last \d+B of line 2 \(3\.9KB in all\)\.\]$/,
    );
    const first = cutText(`${"é".repeat(2000)}\nshort`, limit, {
      keep: "first",
    });
    assert.match(
      first.text,
      /^é+\n\n\[Showing the first \d+B of line 1 \(3\.9KB in all\)\.\]$/,
    );
    for (const cut of [last, first]) {
      assert.equal(cut.text.includes("\uFFFD"), false);
      assert.ok(Buffer.byteLength(cut.text) <= limit.bytes);
    }
  });

  it("passes over blank lines at the end it keeps, and says which lines it shows", () => {
    assert.equal(
      cutText(`${numbered(50)}\n\n\n\n`, limit, { keep: "last" }).text,
      "line 47\nline 48\nline 49\nline 50\n\n[Showing lines 47-50 of 53 (394B in all).]",
    );
    assert.equal(
      cutText(`\n\n${numbered(50)}`, limit, { keep: "first" }).text,
      "line 1\nline 2\nline 3\nline 4\n\n[Showing lines 3-6 of 52 (392B in all).]",
    );
  });

  it("keeps lines that are all blank as they are", () => {
    assert.equal(
      cutText("\n".repeat(50), limit, { keep: "last" }).text,
      "\n\n\n\n\n[Showing lines 47-50 of 50 (50B in all).]",
    );
  });

  it("leaves out a path too long to fit beside any output", () => {
    const cut = cutText(numbered(50), limit, {
      keep: "last",
      path: `/tmp/${"x".repeat(990)}`,
    });
    assert.match(cut.text, /\[Showing lines 47-50 of 50 \(390B in all\)\.\]$/);
  });

  it("is cut whatever its size when it is the end of a larger output", () => {
    assert.deepEqual(
      cutText("line 99\nline 100\n", limit, {
        keep: "last",
        total: { lines: 100, bytes: 891 },
      }),
      {
        text: "line 99\nline 100\n\n[Showing lines 99-100 of 100 (891B in all).]",
        truncated: true,
      },
    );
  });

  it("counts lines and sizes as a reader would", () => {
    assert.deepEqual(
      ["", "a", "a\n", "a\nb", "a\n\n"].map(countLines),
      [0, 1, 1, 2, 2],
    );
    assert.deepEqual([512, 51_200, 1_500_000].map(formatSize), [
      "512B",
      "50.0KB",
      "1.4MB",
    ]);
  });
});

describe("every text cut to the output limit", () => {
  it("is within the limit, made of the text's own lines, and says truly which", () => {
    for (let seed = 1; seed <= 3_000; seed++) {
      const random = seeded(seed);
      const limit = {
        lines: random.pick([3, 4, 5, 20, 200, 2000]),
        bytes: random.pick([1024, 1100, 2000, 5000, 51_200]),
      };
      const text = randomText(random, random.pick([5, 50, 400]));
      const keep = random.pick(["first", "last"] as const);
      const path = random.chance(0.5)
        ? `/tmp/${"x".repeat(random.pick([5, 60, 900]))}`
        : undefined;
      const where = `seed ${seed}, ${JSON.stringify(limit)}, keep ${keep}`;

      const cut = cutText(text, limit, { keep, path });
      if (!cut.truncated) {
        assert.equal(cut.text, text, where);
        assert.ok(withinLimit(text, limit), where);
        continue;
      }
      assert.ok(Buffer.byteLength(cut.text) <= limit.bytes, where);
      assert.ok(countLines(cut.text) <= limit.lines, where);
      assert.ok(
        !cut.text.includes("\uFFFD") || text.includes("\uFFFD"),
        `a character was cut in two: ${where}`,
      );
      assertCutOf(text, cut.text, where);
      assert.equal(
        cutText(cut.text, limit, { keep }).truncated,
        false,
        `cut again: ${where}`,
      );
    }
  });
});
