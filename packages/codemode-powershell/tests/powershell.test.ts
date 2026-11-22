/**
 * The PowerShell package: its one action through a real engine and a real
 * PowerShell, and the package as codemode's package manager loads it. The
 * tests that run a command need a PowerShell on `PATH`: without one they are
 * skipped, except in CI, where they fail.
 */

import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { commandPath, type ShellResult } from "@shiftlabs/codemode/utils/cli";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import { assertLargeOutputIsCutForTheRun } from "../../package-tests/shell.js";
import powershell, {
  powershellScript,
  resolvePowerShell,
} from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const installed = commandPath("pwsh") ?? commandPath("powershell");
const withPowerShell = installed || process.env.CI ? it : it.skip;

const harness = pluginHarness(powershell, "powershell");
const codemode = harness.codemode;
const run = (
  input: Record<string, unknown>,
  config?: Record<string, unknown>,
) => harness.call<ShellResult>("run", input, config);

const lines = (output: string) => output.trim().split(/\r?\n/);

describe("powershell.run", () => {
  withPowerShell("returns a command's output and exit code", async () => {
    const result = await run({
      command: "Write-Output hello; $PSVersionTable.PSVersion.Major -ge 5",
    });
    assert.deepEqual(lines(result.output), ["hello", "True"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
  });

  withPowerShell("returns the exit code a command exits with", async () => {
    const result = await run({ command: "Write-Output looked; exit 3" });
    assert.deepEqual(lines(result.output), ["looked"]);
    assert.equal(result.exitCode, 3);
  });

  withPowerShell(
    "returns 1 for a command whose last statement failed, with the error as plain text",
    async () => {
      const result = await run({
        command: `Get-Item ${JSON.stringify(join(harness.tmp, "missing"))}`,
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /Cannot find path/);
      assert.equal(result.output.includes("\u001b["), false);
    },
  );

  withPowerShell(
    "returns 1 for a command that cannot be parsed, with the error as plain text",
    async () => {
      const result = await run({ command: "Get-ChildItem | )" });
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /empty pipe element/);
      assert.equal(result.output.includes("\u001b["), false);
    },
  );

  withPowerShell("writes its output as UTF-8", async () => {
    const result = await run({ command: 'Write-Output "héllo ✓"' });
    assert.deepEqual(lines(result.output), ["héllo ✓"]);
  });

  withPowerShell("starts each call afresh", async () => {
    const { result, error } = await codemode({ cwd: harness.tmp }).execute(`
      await powershell.run({ command: "Set-Location ..; $kept = 1" });
      return (await powershell.run({ command: '(Get-Location).Path; "kept=$kept"' })).output;
    `);
    assert.equal(error, undefined);
    assert.deepEqual(lines(result as string), [harness.tmp, "kept="]);
  });

  withPowerShell(
    "runs in the connection's directory, or the call's within it",
    async () => {
      mkdirSync(join(harness.tmp, "inner"));
      const where = { command: "(Get-Location).Path" };
      assert.deepEqual(lines((await run(where, { cwd: harness.tmp })).output), [
        harness.tmp,
      ]);
      assert.deepEqual(
        lines(
          (await run({ ...where, cwd: "inner" }, { cwd: harness.tmp })).output,
        ),
        [join(harness.tmp, "inner")],
      );
    },
  );

  withPowerShell(
    "rejects a command that outlives its timeout, with what it wrote",
    async () => {
      const { error } = await codemode().execute(
        `return await powershell.run({ command: "Write-Output started; Start-Sleep -Seconds 60", timeoutMs: 5000 })`,
      );
      assert.match(
        error ?? "",
        /started\r?\n\r?\nCommand timed out after 5 seconds/,
      );
    },
  );

  withPowerShell(
    "hands code all of a large output, and the run its last lines",
    () =>
      assertLargeOutputIsCutForTheRun(
        harness,
        `powershell.run({ command: "[Console]::Out.Write('a' * 1500000); Write-Output END; exit 4" })`,
      ),
  );

  it("refuses input that is not a command", async () => {
    for (const input of [{}, { command: "" }, { command: "ls", timeout: 5 }]) {
      const { error } = await codemode().execute(
        `return await powershell.run(${JSON.stringify(input)})`,
      );
      assert.match(error ?? "", /Invalid input for powershell\.run/);
    }
  });
});

describe("the shell powershell.run uses", () => {
  withPowerShell("is the one the connection names", async () => {
    const result = await run(
      { command: "(Get-Process -Id $PID).Path" },
      { shell: installed },
    );
    assert.deepEqual(lines(result.output), [realpathSync(installed as string)]);
    assert.deepEqual(resolvePowerShell(installed), {
      program: installed,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
      ],
    });
  });

  it("is refused when it is not there", () => {
    assert.throws(
      () => resolvePowerShell(join(harness.tmp, "no-such-shell")),
      /powershell: no shell at /,
    );
  });
});

describe("the script a PowerShell is handed", () => {
  const WINDOWS_POWERSHELL =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe";

  it("is the command after the line that sets its output's encoding", () => {
    const script = powershellScript("Get-Date", "/usr/local/bin/pwsh");
    assert.deepEqual(script.split("\n").slice(1), ["Get-Date"]);
    assert.match(script, /OutputEncoding.*UTF8/);
  });

  it("ends, in Windows PowerShell, with lines that settle the exit code", () => {
    const script = powershellScript("git status 2>&1", WINDOWS_POWERSHELL);
    assert.match(script, /\ngit status 2>&1\n;\nif \(\$\?\) \{ exit 0 \}\n/);
    assert.ok(script.endsWith("\nexit 1"));
  });

  it("leaves a command that continues its last line as it is", () => {
    assert.ok(
      powershellScript("Get-Date `", WINDOWS_POWERSHELL).endsWith(
        "\nGet-Date `",
      ),
    );
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-powershell",
  plugin: "powershell",
  actions: 1,
  write: 1,
});
