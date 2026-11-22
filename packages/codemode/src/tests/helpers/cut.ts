// What must hold of any text that was cut to a limit: it closes with a
// line that names the lines shown, and those are the text's own lines.

import assert from "node:assert/strict";

const CLOSING =
  /\n\n\[Showing (?:lines (\d+)-(\d+) of (\d+)|the (?:first|last) [\d.]+(?:B|KB|MB) of line (\d+)) \([\d.]+(?:B|KB|MB) in all\)\.(?: Full output: [^\n]+)?\]$/;

/** The lines of `text` as the limit counts them. */
function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return text ? lines : [];
}

/** Check `cut` against the `text` it was cut from. `where` names the case in a failure. */
export function assertCutOf(text: string, cut: string, where: string): void {
  const closing = CLOSING.exec(cut);
  assert.ok(closing, `no closing line: ${where}`);
  const shown = cut.slice(0, closing.index);
  const lines = linesOf(text);
  const [, from, to, total, partialLine] = closing;
  if (partialLine !== undefined) {
    const line = lines[Number(partialLine) - 1];
    assert.ok(
      line?.includes(shown),
      `not part of line ${partialLine}: ${where}`,
    );
    return;
  }
  assert.equal(Number(total), lines.length, `the total is wrong: ${where}`);
  assert.ok(Number(from) <= Number(to), `no lines named: ${where}`);
  assert.equal(
    shown,
    lines.slice(Number(from) - 1, Number(to)).join("\n"),
    `the lines named are not the lines shown: ${where}`,
  );
  assert.ok(shown.trim() || !text.trim(), `nothing shown: ${where}`);
}
