/**
 * A host stops a run and follows its output: `signal` and `onOutput` on
 * `execute()`, through a real engine and real processes.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { PluginFunction } from "../plugin/api.js";
import { Codemode } from "../sdk.js";
import {
  type ProgramResult,
  runProgram,
  type ShellResult,
  shellConnectionSchema,
  shellRunAction,
} from "../utils/cli.js";
import { type ActionOutput, OutputFollower } from "../utils/follow.js";
import { ends, pidIn } from "./helpers/processes.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "codemode-follow-")));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The commands here are shell scripts. */
const skip = process.platform === "win32";
const posix = skip ? it.skip : it;

/** A plugin with a `run` action, as the shell packages have, one that runs a program, and one that produces output of its own. */
const demo: PluginFunction = (rl) => {
  rl.setName("demo");
  rl.setConnectionSchema(shellConnectionSchema("sh"));
  rl.registerAction(
    "run",
    shellRunAction({
      shell: "sh",
      outputFilePrefix: "codemode-follow-test",
      prepare: (command) => ({
        program: { program: "/bin/sh", args: ["-c"] },
        script: command,
      }),
    }),
  );
  rl.registerAction("sh", {
    execute: (input, ctx) =>
      runProgram(ctx, "/bin/sh", ["-c", (input as { line: string }).line]),
  });
  rl.registerAction("count", {
    async execute(input, ctx) {
      const { from = 1, to } = input as { from?: number; to: number };
      for (let n = from; n <= to; n++) await ctx.output(`${n}\n`);
      return to;
    },
  });
};

const host = () => Codemode.create({ plugins: [demo] });

describe("stopping a run", { skip }, () => {
  it("ends the command it waits on, and settles with an error", async () => {
    const codemode = host();
    const pidFile = join(dir, "stop-pid");
    const stop = new AbortController();
    try {
      const run = codemode.execute(
        `return await demo.run({ command: "sleep 30 & echo $! > ${pidFile}; wait" })`,
        { signal: stop.signal, timeoutMs: 0 },
      );
      const pid = await pidIn(pidFile);
      stop.abort();
      const { error, result } = await run;
      assert.equal(error, "Execution aborted");
      assert.equal(result, null);
      assert.equal(await ends(pid), true);
      // The instance runs the next body as usual.
      const next = await codemode.execute(
        'return (await demo.run({ command: "echo again" })).output',
      );
      assert.equal(next.result, "again\n");
    } finally {
      codemode.dispose();
    }
  });

  it("starts nothing when it is aborted before it begins", async () => {
    const codemode = host();
    const marker = join(dir, "never");
    try {
      const { error } = await codemode.execute(
        `return await demo.run({ command: "touch ${marker}" })`,
        { signal: AbortSignal.abort() },
      );
      assert.equal(error, "Execution aborted");
      assert.equal(existsSync(marker), false);
    } finally {
      codemode.dispose();
    }
  });
});

describe("following a run", { skip }, () => {
  it("hands over a command's output before the command exits", async () => {
    const codemode = host();
    const release = join(dir, "release");
    const seen: ActionOutput[] = [];
    try {
      // The command ends only once the host has read its first line.
      const run = await codemode.execute(
        `return await demo.run({ command: "echo first; while [ ! -e ${release} ]; do sleep 0.05; done; echo second >&2" })`,
        {
          timeoutMs: 0,
          onOutput: (output) => {
            seen.push(output);
            if (output.text.includes("first")) writeFileSync(release, "");
          },
        },
      );
      assert.equal(run.error, undefined);
      assert.deepEqual(
        seen.map(({ text }) => text),
        ["first\n", "second\n"],
      );
      assert.deepEqual(
        { ...seen[0], text: undefined },
        { plugin: "demo", action: "run", path: "demo.run", text: undefined },
      );
      // What the action returns is the same with a host following.
      assert.deepEqual((run.result as ShellResult).output.split("\n").sort(), [
        "",
        "first",
        "second",
      ]);
    } finally {
      codemode.dispose();
    }
  });

  it("holds a fast writer back while the reader is slow", async () => {
    const codemode = host();
    const done = join(dir, "written");
    const bytes = 4_000_000;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let received = 0;
    let inFlight = 0;
    let overlapped = false;
    try {
      const run = codemode.execute(
        `return await demo.sh({ line: "head -c ${bytes} /dev/zero | tr '\\\\0' a; touch ${done}" })`,
        {
          timeoutMs: 0,
          maxActionOutputBytes: 16 * 1024 * 1024,
          outputLimit: false,
          onOutput: async ({ text }) => {
            overlapped ||= ++inFlight > 1;
            received += text.length;
            reached();
            await gate;
            inFlight--;
          },
        },
      );
      await first;
      // The reader holds its first piece. The writer fills the pipe and
      // waits there: it cannot finish while nothing is read.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(existsSync(done), false);
      assert.ok(received < bytes / 4, `${received} bytes handed over early`);
      open();
      const { result, error } = await run;
      assert.equal(error, undefined);
      assert.equal(received, bytes);
      assert.equal(overlapped, false);
      assert.equal((result as ProgramResult).stdout.length, bytes);
      assert.equal(existsSync(done), true);
    } finally {
      codemode.dispose();
    }
  });

  it("delivers an action's own output one piece at a time, in order", async () => {
    const codemode = host();
    const seen: string[] = [];
    try {
      const run = await codemode.execute("return await demo.count({ to: 5 })", {
        onOutput: async ({ text, path }) => {
          assert.equal(path, "demo.count");
          // Slower for the earlier pieces: order is the engine's, not the timing's.
          await new Promise((resolve) => setTimeout(resolve, 6 - Number(text)));
          seen.push(text);
        },
      });
      assert.equal(run.result, 5);
      assert.deepEqual(seen, ["1\n", "2\n", "3\n", "4\n", "5\n"]);
    } finally {
      codemode.dispose();
    }
  });

  it("follows two actions at once independently", async () => {
    const codemode = host();
    let sawNine: () => void = () => {};
    const nine = new Promise<void>((resolve) => {
      sawNine = resolve;
    });
    try {
      // The first action's piece is held until the second's has arrived.
      const run = await codemode.execute(
        "return await Promise.all([demo.count({ to: 1 }), demo.count({ from: 9, to: 9 })])",
        {
          onOutput: ({ text }) => {
            if (text === "9\n") sawNine();
            else return nine;
          },
        },
      );
      assert.deepEqual(run.result, [1, 9]);
    } finally {
      codemode.dispose();
    }
  });

  it("is not broken by a listener that throws, and needs no listener", async () => {
    const codemode = host();
    try {
      for (const onOutput of [
        () => {
          throw new Error("listener failed");
        },
        async () => {
          throw new Error("listener rejected");
        },
        undefined,
      ]) {
        const run = await codemode.execute(
          'return (await demo.run({ command: "echo one; echo two" })).output',
          { onOutput },
        );
        assert.equal(run.result, "one\ntwo\n");
      }
    } finally {
      codemode.dispose();
    }
  });

  it("stops a command whose reader never catches up, when the run is aborted", async () => {
    const codemode = host();
    const stop = new AbortController();
    let reached: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      reached = resolve;
    });
    try {
      const run = codemode.execute(
        'return await demo.run({ command: "while true; do echo line; done" })',
        {
          signal: stop.signal,
          timeoutMs: 0,
          onOutput: () => {
            reached();
            return new Promise<void>(() => {});
          },
        },
      );
      await first;
      stop.abort();
      assert.equal((await run).error, "Execution aborted");
    } finally {
      codemode.dispose();
    }
  });
});

describe("a process's output on its way to the host", () => {
  it("arrives as whole characters, each pipe decoded on its own", async () => {
    const seen: string[] = [];
    const follower = new OutputFollower((text) => {
      seen.push(text);
    });
    const [first, second] = [Buffer.from([0xc3]), Buffer.from([0xa9])];
    assert.equal(follower.take(first, "stdout"), true);
    follower.take(Buffer.from("err"), "stderr");
    follower.take(second, "stdout");
    follower.take(first, "stderr");
    await follower.finish();
    assert.deepEqual(seen, ["err", "é", "\uFFFD"]);
  });

  it("is read again once a slow host has taken it, and when a host's own context rejects", async () => {
    let release: () => void = () => {};
    const outputs = [
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      () => Promise.reject(new Error("a context of the host's own")),
    ];
    for (const output of outputs) {
      const follower = new OutputFollower(output);
      assert.equal(follower.take(Buffer.from("one"), "stdout"), false);
      let drained = false;
      const waiting = follower.drained().then(() => {
        drained = true;
      });
      await Promise.resolve();
      release();
      await waiting;
      assert.equal(drained, true);
    }
  });

  posix("reaches a context that is not the engine's", async () => {
    const seen: string[] = [];
    const result = await runProgram(
      {
        signal: new AbortController().signal,
        output: (text: string) => {
          seen.push(text);
        },
      } as Parameters<typeof runProgram>[0],
      "/bin/sh",
      ["-c", "echo out; echo err >&2"],
    );
    assert.equal(result.stdout, "out\n");
    assert.deepEqual(seen.sort(), ["err\n", "out\n"]);
  });
});
