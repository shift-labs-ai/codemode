/**
 * `runShell`: one script through a real shell, each case a new process.
 * The cases need a POSIX shell; Windows has its own process handling,
 * which they do not reach.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isShellError, runShell, type ShellProgram } from "../utils/shell.js";
import { ends, pidIn } from "./helpers/processes.js";

const HOST = fileURLToPath(new URL("./helpers/shell-host.ts", import.meta.url));

const SH: ShellProgram = { program: "/bin/sh", args: ["-c"] };
const posix = process.platform === "win32" ? it.skip : it;

let tmp: string;
const spilled: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codemode-shell-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const path of spilled.splice(0)) rmSync(path, { force: true });
});

describe("running a script through a shell", () => {
  posix("answers stdout and stderr together, and the exit code", async () => {
    const result = await runShell(SH, "echo out; echo err >&2; echo again");
    // Two pipes: each keeps its own order, and the two may interleave.
    assert.deepEqual(result.output.trim().split("\n").sort(), [
      "again",
      "err",
      "out",
    ]);
    assert.ok(result.output.indexOf("out") < result.output.indexOf("again"));
    assert.equal(
      (await runShell(SH, "echo out; echo err; echo again 2>&1")).output,
      "out\nerr\nagain\n",
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.fullOutputPath, undefined);
    assert.ok(result.wallTimeMs >= 0);
  });

  posix("resolves with the exit code of a script that fails", async () => {
    const result = await runShell(SH, "echo before; exit 7");
    assert.equal(result.exitCode, 7);
    assert.equal(result.output, "before\n");
  });

  posix("reports a shell a signal ended as 128 plus the signal", async () => {
    const result = await runShell(SH, "kill -9 $$");
    assert.equal(result.exitCode, 137);
  });

  posix(
    "runs in the directory and with the variables it is given, over the host's",
    async () => {
      process.env.CODEMODE_SHELL_TEST_HOST = "from-host";
      try {
        const result = await runShell(
          SH,
          'pwd; echo "$CODEMODE_SHELL_TEST_HOST $ADDED"',
          { cwd: tmp, env: { ADDED: "added" } },
        );
        const [directory, variables] = result.output.trim().split("\n");
        assert.ok(directory.endsWith(tmp.split("/").at(-1) as string));
        assert.equal(variables, "from-host added");
        const without = await runShell(
          SH,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
          'echo "${CODEMODE_SHELL_TEST_HOST:-unset}"',
          { env: { CODEMODE_SHELL_TEST_HOST: undefined } },
        );
        assert.equal(without.output, "unset\n");
      } finally {
        delete process.env.CODEMODE_SHELL_TEST_HOST;
      }
    },
  );

  posix(
    "sends the script on stdin to a shell that takes it there",
    async () => {
      const result = await runShell(
        { program: "/bin/sh", args: ["-s"], scriptOnStdin: true },
        "echo from stdin",
      );
      assert.equal(result.output, "from stdin\n");
    },
  );

  posix(
    "does not wait for a background process that holds the output open",
    async () => {
      const pidFile = join(tmp, "pid");
      const started = Date.now();
      const result = await runShell(
        SH,
        `sleep 30 & echo $! > ${pidFile}; echo done`,
      );
      assert.equal(result.output, "done\n");
      assert.ok(Date.now() - started < 5_000);
      process.kill(await pidIn(pidFile), "SIGKILL");
    },
  );

  posix("keeps output that arrives after the shell has exited", async () => {
    const result = await runShell(
      SH,
      "(sleep 0.05; echo late; sleep 0.05; echo later) & echo first",
    );
    assert.equal(result.output, "first\nlate\nlater\n");
  });
});

describe("a script that does not run to its end", () => {
  posix(
    "is killed with what it started when it outlives its timeout",
    async () => {
      const pidFile = join(tmp, "pid");
      const failure = await runShell(
        SH,
        `echo started; sleep 30 & echo $! > ${pidFile}; wait`,
        // Long enough for the shell to start and write on a slow machine.
        { timeoutMs: 1_000 },
      ).catch((error) => error);
      assert.ok(isShellError(failure));
      assert.equal(failure.code, "timed_out");
      assert.equal(failure.output, "started\n");
      assert.match(
        failure.message,
        /^started\n\nCommand timed out after 1 seconds$/,
      );
      assert.equal(await ends(await pidIn(pidFile)), true);
    },
  );

  posix(
    "says so when the shell had exited and only its background output remained",
    async () => {
      const failure = await runShell(
        SH,
        "(while true; do echo tick; sleep 0.02; done) & exit 3",
        { timeoutMs: 1_000 },
      ).catch((error) => error);
      assert.ok(isShellError(failure));
      assert.equal(failure.code, "timed_out");
      assert.match(
        failure.message,
        /The shell exited with code 3 after [\d.]+ seconds, but background processes it started kept writing output until the timeout\./,
      );
    },
  );

  posix("is killed with what it started when its caller gives up", async () => {
    const pidFile = join(tmp, "pid");
    const giveUp = new AbortController();
    const run = runShell(SH, `sleep 30 & echo $! > ${pidFile}; wait`, {
      signal: giveUp.signal,
    }).catch((error) => error);
    const pid = await pidIn(pidFile);
    giveUp.abort();
    const failure = await run;
    assert.ok(isShellError(failure));
    assert.equal(failure.code, "aborted");
    assert.equal(await ends(pid), true);

    const before = await runShell(SH, "echo never", {
      signal: AbortSignal.abort(),
    }).catch((error) => error);
    assert.equal(before.code, "aborted");
  });

  it("names the program that could not be started, and a directory that is not there", async () => {
    const missing = await runShell(
      { program: join(tmp, "no-such-shell"), args: ["-c"] },
      "echo hi",
    ).catch((error) => error);
    assert.ok(isShellError(missing));
    assert.equal(missing.code, "spawn_failed");
    assert.match(missing.message, /Could not start .*no-such-shell/);

    const nowhere = await runShell(SH, "echo hi", {
      cwd: join(tmp, "nowhere"),
    }).catch((error) => error);
    assert.equal(nowhere.code, "spawn_failed");
    assert.match(nowhere.message, /Working directory does not exist/);
  });

  it("refuses a timeout that is not a length of time", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      await assert.rejects(runShell(SH, "echo hi", { timeoutMs }), RangeError);
  });
});

describe("a command whose host ends first", () => {
  /** Start a host that runs `sleep` through `runShell`, and answer both pids. */
  async function host(ending: "exit" | "wait") {
    const pidFile = join(tmp, "pid");
    const child = spawn(process.execPath, [HOST, pidFile, ending], {
      stdio: "ignore",
    });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("close", (_code, signal) => resolve(signal)),
    );
    return { child, command: await pidIn(pidFile), closed };
  }

  posix("ends when the host exits", async () => {
    const { command, closed } = await host("exit");
    await closed;
    assert.equal(await ends(command), true);
  });

  posix(
    "ends when the host is interrupted, and the host still ends by that signal",
    async () => {
      const { child, command, closed } = await host("wait");
      child.kill("SIGTERM");
      assert.equal(await closed, "SIGTERM");
      assert.equal(await ends(command), true);
    },
  );
});

describe("output past the limit", () => {
  posix(
    "keeps its start and end, and all of it in a file only the user reads",
    async () => {
      const result = await runShell(
        SH,
        "echo START; i=0; while [ $i -lt 400 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done; echo END",
        {
          maxOutputBytes: 1_000,
          outputFilePrefix: "codemode-shell-test",
          outputDir: tmp,
        },
      );
      assert.equal(result.truncated, true);
      assert.ok(result.fullOutputPath);
      assert.equal(dirname(result.fullOutputPath), tmp);
      assert.match(
        result.fullOutputPath,
        /codemode-shell-test-[0-9a-f]{16}\.log$/,
      );
      assert.ok(result.output.startsWith("START\n"));
      assert.ok(result.output.endsWith("END\n"));
      const total = 6 + 400 * 41 + 4;
      assert.match(
        result.output,
        new RegExp(`\\[\\.\\.\\. ${total - 1_000} bytes omitted \\.\\.\\.\\]`),
      );
      const full = readFileSync(result.fullOutputPath, "utf8");
      assert.equal(full.length, total);
      assert.ok(full.startsWith("START\n") && full.endsWith("END\n"));
      assert.equal(statSync(result.fullOutputPath).mode & 0o777, 0o600);
    },
  );

  posix(
    "still answers its start and end where the file cannot be written",
    async () => {
      const blocked = join(tmp, "a-file");
      writeFileSync(blocked, "");
      const result = await runShell(
        SH,
        "i=0; while [ $i -lt 400 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done; echo END",
        { maxOutputBytes: 1_000, outputDir: blocked },
      );
      assert.equal(result.truncated, true);
      assert.equal(result.fullOutputPath, undefined);
      assert.ok(result.output.endsWith("END\n"));
    },
  );

  posix("writes all of a large, fast output to the file", async () => {
    const bytes = 8_000_000;
    const result = await runShell(
      SH,
      `head -c ${bytes} /dev/zero | tr '\\0' a; echo; echo END`,
      { maxOutputBytes: 1_000 },
    );
    assert.ok(result.fullOutputPath);
    spilled.push(result.fullOutputPath);
    assert.equal(result.exitCode, 0);
    assert.equal(statSync(result.fullOutputPath).size, bytes + 5);
    assert.ok(result.output.endsWith("END\n"));
  });

  posix("cuts between characters, not inside one", async () => {
    const result = await runShell(
      SH,
      "i=0; while [ $i -lt 200 ]; do printf 'é'; i=$((i+1)); done",
      { maxOutputBytes: 101 },
    );
    if (result.fullOutputPath) spilled.push(result.fullOutputPath);
    assert.equal(result.truncated, true);
    assert.equal(result.output.includes("\uFFFD"), false);
  });

  posix("carries a timed-out script's output in the same bound", async () => {
    const failure = await runShell(
      SH,
      "while true; do echo 0123456789012345678901234567890123456789; done",
      { timeoutMs: 1_000, maxOutputBytes: 500 },
    ).catch((error) => error);
    assert.ok(isShellError(failure));
    if (failure.fullOutputPath) spilled.push(failure.fullOutputPath);
    assert.equal(failure.code, "timed_out");
    assert.ok(failure.fullOutputPath);
    assert.ok(Buffer.byteLength(failure.output) < 600);
  });
});
