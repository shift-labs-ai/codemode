/**
 * `runShell`: one script through a real shell, each case a new process.
 * The cases need a POSIX shell; Windows has its own process handling,
 * which they do not reach.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
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
import { commandExists, commandPath } from "../utils/cli.js";
import { isShellError, runShell, type ShellProgram } from "../utils/shell.js";
import { assertCutOf } from "./helpers/cut.js";
import { randomText, seeded } from "./helpers/fuzz.js";
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

describe("finding a command", () => {
  posix("answers where it is on PATH, or that it is not there", () => {
    assert.match(commandPath("sh") ?? "", /\/sh$/);
    assert.equal(commandExists("sh"), true);
    assert.equal(commandPath("codemode-no-such-command"), undefined);
    assert.equal(commandExists("codemode-no-such-command"), false);
  });

  posix("reads PATH in order, and takes only a file that can be run", () => {
    const [first, second] = [join(tmp, "first"), join(tmp, "second")];
    for (const directory of [first, second]) mkdirSync(directory);
    writeFileSync(join(first, "notes"), "", { mode: 0o644 });
    writeFileSync(join(second, "notes"), "", { mode: 0o755 });
    mkdirSync(join(first, "folder"));
    const env = { PATH: `${first}::${second}` };
    assert.equal(commandPath("notes", env), join(second, "notes"));
    assert.equal(commandPath("folder", env), undefined);
    assert.equal(commandPath("notes", { PATH: first }), undefined);
    assert.equal(commandPath("notes", {}), undefined);
    // Only Windows writes the variable's name in another case.
    assert.equal(commandPath("notes", { Path: second }), undefined);
    // A name with a directory in it is a path, not a name to look up.
    assert.equal(commandPath("second/notes", { PATH: tmp }), undefined);
    assert.equal(commandPath(join(second, "notes"), env), undefined);
  });

  it("tries a name with each of PATHEXT's extensions on Windows", () => {
    writeFileSync(join(tmp, "pwsh.EXE"), "");
    writeFileSync(join(tmp, "notes.txt"), "");
    const env = { Path: `C:\\nowhere;${tmp}`, PATHEXT: ".COM;.EXE" };
    assert.equal(commandPath("pwsh", env, "win32"), join(tmp, "pwsh.EXE"));
    assert.equal(commandPath("pwsh.EXE", env, "win32"), join(tmp, "pwsh.EXE"));
    assert.equal(commandPath("notes", env, "win32"), undefined);
    // An extension outside PATHEXT is part of the name.
    assert.equal(commandPath("notes.txt", env, "win32"), undefined);
    assert.equal(
      commandPath("pwsh", { PATH: tmp }, "win32"),
      join(tmp, "pwsh.EXE"),
    );
  });
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
  /**
   * A command that starts `script` in a session of its own, outside the
   * group of the shell that runs it, writes that process's pid to
   * `pidFile`, and stays.
   */
  function leavingTheGroup(pidFile: string, script: string): string {
    const file = join(tmp, "leave.cjs");
    writeFileSync(
      file,
      `const child = require("node:child_process").spawn(
  "/bin/sh", ["-c", ${JSON.stringify(script)}], { detached: true, stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 60_000);`,
    );
    return `"${process.execPath}" "${file}"`;
  }

  posix(
    "is ended with what it started when it outlives its timeout",
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
      const pidFile = join(tmp, "pid");
      const signalled: number[] = [];
      const kill = process.kill;
      process.kill = (pid, signal) => {
        signalled.push(pid);
        return kill.call(process, pid, signal);
      };
      let failure: unknown;
      try {
        failure = await runShell(
          SH,
          `(while true; do echo tick; sleep 0.02; done) & echo $! > ${pidFile}; exit 3`,
          { timeoutMs: 1_000 },
        ).catch((error) => error);
      } finally {
        process.kill = kill;
      }
      assert.ok(isShellError(failure));
      assert.equal(failure.code, "timed_out");
      assert.match(
        failure.message,
        /The command exited with code 3 after [\d.]+ seconds, but background processes it started kept writing output until the timeout\./,
      );
      // The shell had ended, and its group's id with it: nothing is
      // signalled. What it left in the background stays, as after any command.
      assert.deepEqual(signalled, []);
      process.kill(await pidIn(pidFile), "SIGKILL");
    },
  );

  posix("is ended with what it started when its caller gives up", async () => {
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

  posix("is asked to end first, so it can clean up", async () => {
    const [pidFile, cleaned] = [join(tmp, "pid"), join(tmp, "cleaned")];
    const giveUp = new AbortController();
    const run = runShell(
      SH,
      `trap 'echo yes > ${cleaned}; exit 0' TERM; echo $$ > ${pidFile}; sleep 30 & wait`,
      { signal: giveUp.signal },
    ).catch((error) => error);
    await pidIn(pidFile);
    giveUp.abort();
    assert.equal((await run).code, "aborted");
    assert.equal(readFileSync(cleaned, "utf8"), "yes\n");
  });

  posix("ends what left its group for a session of its own", async () => {
    const pidFile = join(tmp, "pid");
    const giveUp = new AbortController();
    const run = runShell(SH, leavingTheGroup(pidFile, "sleep 30"), {
      signal: giveUp.signal,
    }).catch((error) => error);
    const left = await pidIn(pidFile);
    giveUp.abort();
    assert.equal((await run).code, "aborted");
    assert.equal(await ends(left), true);
  });

  posix(
    "is killed when it does not end, with what left its group",
    // The command has END_GRACE_MS to end before it is killed.
    { timeout: 30_000 },
    async () => {
      const [shellFile, pidFile] = [join(tmp, "shell"), join(tmp, "pid")];
      const giveUp = new AbortController();
      // Ignoring a signal is inherited, so nothing here ends when asked.
      const run = runShell(
        SH,
        `trap '' TERM; echo $$ > ${shellFile}; ${leavingTheGroup(pidFile, "sleep 30")}`,
        { signal: giveUp.signal },
      ).catch((error) => error);
      const [shell, left] = [await pidIn(shellFile), await pidIn(pidFile)];
      giveUp.abort();
      assert.equal((await run).code, "aborted");
      assert.equal(await ends(shell), true);
      assert.equal(await ends(left), true);
    },
  );

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

  it("refuses a bound on output too small to say anything in", async () => {
    for (const maxOutputBytes of [0, 1_023, 2_000.5, Number.NaN])
      await assert.rejects(
        runShell(SH, "echo hi", { maxOutputBytes }),
        RangeError,
      );
  });
});

describe("a command whose host ends first", () => {
  /**
   * Start a host that runs a command through `runShell`, and answer both
   * pids. The command is `sleep`, or what `script` makes of the file its pid
   * goes in.
   */
  async function host(
    ending: "exit" | "wait",
    script?: (pidFile: string) => string,
  ) {
    const pidFile = join(tmp, "pid");
    const child = spawn(
      process.execPath,
      [HOST, pidFile, ending, ...(script ? [script(pidFile)] : [])],
      { stdio: "ignore" },
    );
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

  posix(
    "is killed at once when the host is interrupted a second time",
    // Longer than the command's time to end, so a host that waits for it
    // fails by the signal it ends by.
    { timeout: 30_000 },
    async () => {
      const asked = join(tmp, "asked");
      // A command that says it was asked to end, and stays.
      const { child, command, closed } = await host(
        "wait",
        (pidFile) =>
          `trap 'echo $$ > ${asked}' TERM; echo $$ > ${pidFile}; while true; do sleep 1; done`,
      );
      child.kill("SIGTERM");
      assert.equal(await pidIn(asked), command);
      child.kill("SIGINT");
      // The host ends by the second signal, not by the first once the
      // command's time to end is up.
      assert.equal(await closed, "SIGINT");
      assert.equal(await ends(command), true);
    },
  );
});

describe("output past what a command may hold in memory", () => {
  const LINE = "0123456789012345678901234567890123456789";
  const loop = (count: number) =>
    `i=0; while [ $i -lt ${count} ]; do echo ${LINE}; i=$((i+1)); done`;

  posix(
    "keeps its last lines, and all of it in a file only the user reads",
    async () => {
      const result = await runShell(SH, `echo START; ${loop(400)}; echo END`, {
        maxOutputBytes: 1_024,
        outputFilePrefix: "codemode-shell-test",
        outputDir: tmp,
      });
      assert.equal(result.truncated, true);
      assert.ok(result.fullOutputPath);
      assert.equal(dirname(result.fullOutputPath), tmp);
      assert.match(
        result.fullOutputPath,
        /codemode-shell-test-[0-9a-f]{16}\.log$/,
      );
      const total = 6 + 400 * 41 + 4;
      const full = readFileSync(result.fullOutputPath, "utf8");
      assert.equal(full.length, total);
      // The path is part of the closing line, so how many lines fit beside
      // it depends on where the temporary directory is.
      const closing = new RegExp(
        `\\nEND\\n\\n\\[Showing lines (\\d+)-402 of 402 \\(${(total / 1024).toFixed(1)}KB in all\\)\\. Full output: [^\\n]+\\]$`,
      ).exec(result.output);
      assert.ok(closing, result.output.slice(-200));
      assert.ok(
        result.output.endsWith(`Full output: ${result.fullOutputPath}]`),
      );
      assertCutOf(full, result.output, "a command's last lines");
      const bytes = Buffer.byteLength(result.output);
      assert.ok(bytes <= 1_024);
      assert.ok(bytes + LINE.length + 1 > 1_024, "another line fits");
      assert.ok(full.startsWith("START\n") && full.endsWith("END\n"));
      assert.equal(statSync(result.fullOutputPath).mode & 0o777, 0o600);
    },
  );

  posix("returns output within the bound whole", async () => {
    const result = await runShell(SH, loop(20), { maxOutputBytes: 1_024 });
    assert.deepEqual(
      [result.output, result.truncated, result.fullOutputPath],
      [`${LINE}\n`.repeat(20), false, undefined],
    );
  });

  posix(
    "still answers its last lines where the file cannot be written",
    async () => {
      const blocked = join(tmp, "a-file");
      writeFileSync(blocked, "");
      const result = await runShell(SH, `${loop(400)}; echo END`, {
        maxOutputBytes: 1_024,
        outputDir: blocked,
      });
      assert.equal(result.truncated, true);
      assert.equal(result.fullOutputPath, undefined);
      assert.match(
        result.output,
        /\nEND\n\n\[Showing lines \d+-401 of 401 \(16\.0KB in all\)\.\]$/,
      );
    },
  );

  posix("writes all of a large, fast output to the file", async () => {
    const bytes = 8_000_000;
    const result = await runShell(
      SH,
      `head -c ${bytes} /dev/zero | tr '\\0' a; echo; echo END`,
      { maxOutputBytes: 1_024 },
    );
    assert.ok(result.fullOutputPath);
    spilled.push(result.fullOutputPath);
    assert.equal(result.exitCode, 0);
    assert.equal(statSync(result.fullOutputPath).size, bytes + 5);
    assert.match(
      result.output,
      /^END\n\n\[Showing lines 2-2 of 2 \(7\.6MB in all\)\./,
    );
  });

  posix("cuts between characters, not inside one", async () => {
    const result = await runShell(
      SH,
      "i=0; while [ $i -lt 2000 ]; do printf 'é'; i=$((i+1)); done",
      { maxOutputBytes: 1_025 },
    );
    if (result.fullOutputPath) spilled.push(result.fullOutputPath);
    assert.equal(result.truncated, true);
    assert.equal(result.output.includes("\uFFFD"), false);
    // One line too long to keep whole: its end, with the closing line saying so.
    assert.match(
      result.output,
      /^é+\n\n\[Showing the last \d+B of line 1 \(3\.9KB in all\)\./,
    );
    assert.ok(Buffer.byteLength(result.output) <= 1_025);
  });

  posix("carries a timed-out script's output in the same bound", async () => {
    const failure = await runShell(SH, `while true; do echo ${LINE}; done`, {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }).catch((error) => error);
    assert.ok(isShellError(failure));
    if (failure.fullOutputPath) spilled.push(failure.fullOutputPath);
    assert.equal(failure.code, "timed_out");
    assert.ok(failure.fullOutputPath);
    assert.ok(Buffer.byteLength(failure.output) <= 1_024);
    assert.match(failure.output, /\[Showing lines \d+-\d+ of \d+ /);
  });

  posix(
    "holds for every output: within the bound, its own last lines, all of it in the file",
    async () => {
      const source = join(tmp, "source");
      for (let seed = 1; seed <= 60; seed++) {
        const random = seeded(seed);
        const text = randomText(random, random.pick([20, 200, 2000]));
        const maxOutputBytes = random.pick([1_024, 2_000, 20_000]);
        writeFileSync(source, text);
        const result = await runShell(SH, `cat ${source}`, {
          maxOutputBytes,
          outputDir: tmp,
        });
        const where = `seed ${seed}, ${maxOutputBytes} bytes`;
        if (Buffer.byteLength(text) <= maxOutputBytes) {
          assert.deepEqual([result.output, result.truncated], [text, false]);
          continue;
        }
        assert.equal(result.truncated, true, where);
        assert.ok(Buffer.byteLength(result.output) <= maxOutputBytes, where);
        assert.equal(
          readFileSync(result.fullOutputPath as string, "utf8"),
          text,
          where,
        );
        assertCutOf(text, result.output, where);
      }
    },
  );
});
