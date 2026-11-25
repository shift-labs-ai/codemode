/**
 * `codemode lint` as a person runs it: the real command in its own
 * process, with its own home folder, on a package written to disk.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

const plugin = (
  body: string,
  input = "t.Object({}, { additionalProperties: false })",
) => `
import type { CodemodePluginAPI } from "@shiftlabs/codemode";
import * as t from "typebox";
export default function shop(rl: CodemodePluginAPI) {
  rl.setName("shop");
  rl.setVersion("1.0.0");
  rl.registerAction("item.list", {
    access: "read",
    description: "List items.",
    inputSchema: ${input},
    async execute() { ${body} },
  });
}
`;

describe("codemode lint", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codemode-lint-cli-"));
    mkdirSync(join(tmp, "home"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(body: string, input?: string): string {
    const dir = join(tmp, "shop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "codemode-shop",
        version: "1.0.0",
        type: "module",
        peerDependencies: { "@shiftlabs/codemode": "*", typebox: "*" },
      }),
    );
    writeFileSync(join(dir, "index.ts"), plugin(body, input));
    return dir;
  }

  /** The command's output and status; `code` is null when it was killed at the timeout. */
  function codemode(args: string[]) {
    return promisify(execFile)(process.execPath, [MAIN, ...args], {
      cwd: tmp,
      env: { ...process.env, HOME: join(tmp, "home"), NO_COLOR: "1" },
      timeout: 30_000,
    }).then(
      (out) => ({ ...out, code: 0 }),
      (error) =>
        error as { stdout: string; stderr: string; code: number | null },
    );
  }

  it("passes a clean plugin with status 0 and says so", async () => {
    const { code, stdout } = await codemode(["lint", write("return [];")]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /✓ no errors/);
    assert.match(stdout, /shop 1\.0\.0: 1 actions \(1 read, 0 write\)/);
  });

  it("exits 1 on an error, and --json prints the report with the finding", async () => {
    const { code, stdout } = await codemode([
      "lint",
      write("return process.env.SHOP_TOKEN;"),
      "--json",
    ]);
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.findings.map((f: { rule: string; plugin: string }) => [
        f.rule,
        f.plugin,
      ]),
      [["run/env-read", "shop"]],
    );
  });

  it("exits 0 on warnings alone, and prints each with the actions it names", async () => {
    const { code, stdout } = await codemode([
      "lint",
      write(
        "return [];",
        't.Object({ sku: t.String({ pattern: "^sku_" }) }, { additionalProperties: false })',
      ),
    ]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /▲ run\/not-run shop Not run, .* \(item\.list\)/);
    assert.match(stdout, /✓ no errors, 1 warning$/m);
  });

  it("returns when an action leaves work holding the process open", async () => {
    // The action is cut at the 3 s action timeout; the interval it left
    // would keep the process alive until killed if the command did not exit.
    const { code, stdout } = await codemode([
      "lint",
      write("setInterval(() => {}, 1_000); await new Promise(() => {});"),
    ]);
    assert.equal(code, 0, stdout);
  });
});
