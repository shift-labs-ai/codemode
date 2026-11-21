/**
 * `ctx.signal`: how an action learns that the run which called it is over,
 * so work it still waits on elsewhere can be stopped with the run.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../config/types.js";
import { ExecutionEngine } from "../core/engine.js";
import { createPluginAPI } from "../plugin/api.js";
import { PluginRegistry } from "../plugin/registry.js";

function engineWith(signals: AbortSignal[], aborts: string[]) {
  const { api, resolve } = createPluginAPI("probe");
  api.registerAction("quick", {
    execute(_input, ctx) {
      assert.ok(ctx.signal);
      signals.push(ctx.signal);
      return ctx.signal.aborted;
    },
  });
  api.registerAction("hang", {
    execute(_input, ctx) {
      assert.ok(ctx.signal);
      signals.push(ctx.signal);
      const signal = ctx.signal;
      return new Promise((_resolve, reject) => {
        const stop = () => {
          aborts.push("hang");
          reject(new Error("stopped"));
        };
        // The run may be over before the call is dispatched.
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop);
      });
    },
  });
  const registry = new PluginRegistry();
  registry.register(resolve());
  return new ExecutionEngine(registry, { ...DEFAULT_CONFIG, timeoutMs: 5000 });
}

describe("an action's abort signal", () => {
  it("is live during the call and aborted once the run has returned", async () => {
    const signals: AbortSignal[] = [];
    const engine = engineWith(signals, []);
    try {
      const { result } = await engine.execute(
        "return [await probe.quick(), await probe.quick()]",
      );
      assert.deepEqual(result, [false, false]);
      assert.equal(signals.length, 2);
      assert.equal(signals[0], signals[1]);
      assert.equal(signals[0].aborted, true);
    } finally {
      engine.dispose();
    }
  });

  it("aborts a call still waiting when the run times out", async () => {
    const signals: AbortSignal[] = [];
    const aborts: string[] = [];
    const engine = engineWith(signals, aborts);
    try {
      // The run ends once the call is waiting, however slowly its worker
      // starts: a run that times out first has made no call to abort.
      const { error } = await engine.execute(
        "await probe.quick(); return await probe.hang()",
        { timeoutMs: 1_000 },
      );
      assert.match(error ?? "", /timed out/);
      assert.equal(signals.length, 2);
      assert.deepEqual(aborts, ["hang"]);
    } finally {
      engine.dispose();
    }
  });

  it("aborts a call the code started and did not wait for", async () => {
    const aborts: string[] = [];
    const engine = engineWith([], aborts);
    try {
      const { result } = await engine.execute(
        "void probe.hang().catch(() => {}); return 'done'",
      );
      assert.equal(result, "done");
      assert.deepEqual(aborts, ["hang"]);
    } finally {
      engine.dispose();
    }
  });

  it("gives each run its own signal", async () => {
    const signals: AbortSignal[] = [];
    const engine = engineWith(signals, []);
    try {
      await engine.execute("return await probe.quick()");
      await engine.execute("return await probe.quick()");
      assert.notEqual(signals[0], signals[1]);
    } finally {
      engine.dispose();
    }
  });
});
