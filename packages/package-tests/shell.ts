/**
 * What the tests of the packages with a `run` action share: a run that
 * returns a large output hands code all of it, and whoever asked for the
 * run its last lines beside the exit code.
 */

import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ShellResult } from "@shiftlabs/codemode/utils/cli";
import type { PluginHarness } from "./harness.js";

/**
 * `call` is the action's call as code writes it, for a script that writes
 * 1.5 MB on one line, then `END`, and exits with 4.
 */
export async function assertLargeOutputIsCutForTheRun(
  harness: PluginHarness,
  call: string,
): Promise<void> {
  const outputDir = join(harness.tmp, "outbox");
  const inside = await harness
    .codemode({}, { outputDir })
    .execute(`return (await ${call}).output.length`);
  assert.ok((inside.result as number) >= 1_500_003);

  const { result, truncated, fullResultPath, error } = await harness
    .codemode({}, { outputDir })
    .execute(`return await ${call}`);
  assert.equal(error, undefined);
  assert.equal(truncated, true);
  const found = result as ShellResult;
  assert.equal(found.exitCode, 4);
  assert.match(
    found.output,
    /END\r?\n\n\[Showing .* \(1\.4MB in all\)\. Full output: /,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(found, null, 2)) <= 51_200);
  assert.ok(fullResultPath);
  assert.equal(dirname(fullResultPath), outputDir);
  assert.match(fullResultPath, /codemode-result-[0-9a-f]{16}\.json$/);
  assert.ok(statSync(fullResultPath).size > 1_500_000);
}
