/**
 * How a host follows what an action produces while it runs. A host passes
 * `onOutput` to `execute()`; the engine gives each call a `ctx.output` bound
 * to it, and `runShell` and `runProgram` hand it what their process writes.
 */

import { StringDecoder } from "node:string_decoder";

/** Output an action handed to `ctx.output`, as the host receives it. */
export interface ActionOutput {
  plugin: string;
  action: string;
  /** The full callable path, "plugin.action". */
  path: string;
  text: string;
}

/**
 * Receives an action's output as it is produced. A promise it returns holds
 * that call's output back until it settles: the next piece is not delivered,
 * and a command is not read, before then. What it throws is ignored.
 */
export type OutputListener = (output: ActionOutput) => void | Promise<void>;

/**
 * The `ctx.output` of one action call. Pieces reach the listener one at a
 * time and in order. It answers a promise while the listener is behind,
 * which settles when everything handed over so far is taken, or when the
 * run ends: nothing is delivered after that.
 */
export function followedOutput(
  listener: OutputListener | undefined,
  call: Omit<ActionOutput, "text">,
  signal: AbortSignal,
): (text: string) => void | Promise<void> {
  if (!listener) return () => {};
  let tail: Promise<void> | undefined;
  let ended: Promise<void> | undefined;
  const hold = (pending: Promise<unknown>): Promise<void> => {
    const link: Promise<void> = pending.then(
      () => {},
      () => {},
    );
    void link.then(() => {
      if (tail === link) tail = undefined;
    });
    tail = link;
    ended ??= new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return Promise.race([link, ended]);
  };
  return (text) => {
    if (!text || signal.aborted) return;
    const deliver = () => listener({ ...call, text });
    if (tail)
      return hold(tail.then(() => (signal.aborted ? undefined : deliver())));
    let taken: void | Promise<void>;
    try {
      taken = deliver();
    } catch {
      return;
    }
    if (taken && typeof taken.then === "function") return hold(taken);
  };
}

/**
 * Hands a process's output to `ctx.output` as text. Each pipe is decoded on
 * its own, so a character split between two chunks arrives whole.
 */
export class OutputFollower {
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private behind: Promise<void> | undefined;

  constructor(
    private readonly output:
      | ((text: string) => void | Promise<void>)
      | undefined,
  ) {}

  /** Take what a pipe wrote. Answers false while the host is behind: stop reading until `drained()`. */
  take(chunk: Buffer, from: "stdout" | "stderr"): boolean {
    return this.send(this.decoders[from].write(chunk));
  }

  /** Resolves when the host has taken what it was handed. */
  drained(): Promise<void> {
    return this.behind ?? Promise.resolve();
  }

  /** Hand over what is left of an unfinished character, once the process has ended. */
  async finish(): Promise<void> {
    this.send(this.decoders.stdout.end());
    this.send(this.decoders.stderr.end());
    await this.drained();
  }

  private send(text: string): boolean {
    if (!text || !this.output) return true;
    const waiting = this.output(text);
    if (!waiting) return true;
    const behind = waiting.then(() => {
      if (this.behind === behind) this.behind = undefined;
    });
    this.behind = behind;
    return false;
  }
}
