/**
 * The PowerShell package: its one action through a real engine and a real
 * PowerShell, and the package as codemode's package manager loads it. The
 * tests that run a command need a PowerShell on `PATH`.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  Codemode,
  MemoryPackageStore,
  PackageManager,
} from "@shiftlabs/codemode";
import { commandPath, type ShellResult } from "@shiftlabs/codemode/utils/cli";
import powershell, {
  powershellScript,
  resolvePowerShell,
} from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const installed = commandPath("pwsh") ?? commandPath("powershell");
const withPowerShell = installed ? it : it.skip;

let tmp: string;
const instances: Codemode[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "codemode-powershell-")));
});

afterEach(() => {
  for (const codemode of instances.splice(0)) codemode.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

function codemode(
  config: Record<string, unknown> = {},
  options: Parameters<typeof Codemode.create>[0] = {},
) {
  const created = Codemode.create({
    plugins: [powershell],
    connections: [{ name: "powershell", plugin: "powershell", config }],
    ...options,
  });
  instances.push(created);
  return created;
}

/** Run one command through the engine and answer the action's result. */
async function run(
  input: Record<string, unknown>,
  config: Record<string, unknown> = {},
): Promise<ShellResult> {
  const { result, error } = await codemode(config).execute(
    `return await powershell.run(${JSON.stringify(input)})`,
  );
  assert.equal(error, undefined);
  return result as ShellResult;
}

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
        command: `Get-Item ${JSON.stringify(join(tmp, "missing"))}`,
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /Cannot find path/);
      assert.equal(result.output.includes("\u001b["), false);
    },
  );

  withPowerShell("writes its output as UTF-8", async () => {
    const result = await run({ command: 'Write-Output "héllo ✓"' });
    assert.deepEqual(lines(result.output), ["héllo ✓"]);
  });

  withPowerShell("starts each call afresh", async () => {
    const { result, error } = await codemode({ cwd: tmp }).execute(`
      await powershell.run({ command: "Set-Location ..; $kept = 1" });
      return (await powershell.run({ command: '(Get-Location).Path; "kept=$kept"' })).output;
    `);
    assert.equal(error, undefined);
    assert.deepEqual(lines(result as string), [tmp, "kept="]);
  });

  withPowerShell(
    "runs in the connection's directory, or the call's within it",
    async () => {
      mkdirSync(join(tmp, "inner"));
      const where = { command: "(Get-Location).Path" };
      assert.deepEqual(lines((await run(where, { cwd: tmp })).output), [tmp]);
      assert.deepEqual(
        lines((await run({ ...where, cwd: "inner" }, { cwd: tmp })).output),
        [join(tmp, "inner")],
      );
    },
  );

  withPowerShell(
    "rejects a command that outlives its timeout, with what it wrote",
    async () => {
      const { error } = await codemode().execute(
        `return await powershell.run({ command: "Write-Output started; Start-Sleep -Seconds 30", timeoutMs: 3000 })`,
      );
      assert.match(
        error ?? "",
        /started\r?\n\r?\nCommand timed out after 3 seconds/,
      );
    },
  );

  withPowerShell(
    "keeps output past the limit in the host's output directory",
    async () => {
      const outputDir = join(tmp, "outbox");
      const { result, error } = await codemode({}, { outputDir }).execute(
        `return await powershell.run({ command: "[Console]::Out.Write('a' * 1500000); Write-Output END" })`,
      );
      assert.equal(error, undefined);
      const found = result as ShellResult;
      assert.equal(found.truncated, true);
      assert.deepEqual(lines(found.output).at(-1)?.slice(-3), "END");
      assert.ok(found.fullOutputPath);
      assert.equal(dirname(found.fullOutputPath), outputDir);
      assert.match(
        found.fullOutputPath,
        /codemode-powershell-[0-9a-f]{16}\.log$/,
      );
      assert.ok(statSync(found.fullOutputPath).size >= 1_500_004);
    },
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
      () => resolvePowerShell(join(tmp, "no-such-shell")),
      /powershell: no shell at /,
    );
  });
});

describe("the script a PowerShell is handed", () => {
  const WINDOWS_POWERSHELL =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe";

  it("is the command after the lines that set its output", () => {
    const script = powershellScript("Get-Date", "/usr/local/bin/pwsh");
    assert.ok(script.endsWith("\nGet-Date"));
    assert.match(script, /OutputEncoding/);
    assert.match(script, /PlainText/);
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

describe("the package", () => {
  it("loads through the package manager as one plugin named powershell", async () => {
    const packages = new PackageManager({
      roots: { user: join(tmp, "user") },
      store: new MemoryPackageStore({ user: [PACKAGE] }),
    });
    // The package needs a codemode after 0.46.0, and the workspace's carries
    // its last release's version until the next one: that warning is right.
    const beyondPeer = (problems: Array<{ code: string }>) =>
      problems.filter((problem) => problem.code !== "peer_unsatisfied");
    const report = await packages.inspect(await packages.fetch(PACKAGE));
    assert.deepEqual(beyondPeer(report.problems), []);
    assert.equal(report.name, "@shiftlabs/codemode-powershell");
    assert.equal(report.plugins[0].version, report.version);
    assert.deepEqual(
      report.plugins.map(({ name, actions, write }) => [name, actions, write]),
      [["powershell", 1, 1]],
    );
    const { plugins, problems } = await packages.load();
    assert.deepEqual(beyondPeer(problems), []);
    assert.equal(
      plugins[0].sourceInfo?.owner,
      `local:${PACKAGE.replace(/\/$/, "")}`,
    );
  });
});
