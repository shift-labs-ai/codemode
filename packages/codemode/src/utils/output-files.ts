/**
 * Output files: what codemode and its plugins write so that a caller can
 * reach output it was not handed in full, such as a command's whole output,
 * a run's whole result, or generated media. Every one is created here, in
 * the directory the host names, so where they are kept is decided in one
 * place.
 */

import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  rmSync,
  type WriteStream,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How much of what it produces one action holds in memory and hands to the
 * code that called it, unless the host sets another amount. Past it, an
 * action that produces output in parts keeps the rest in a file. It guards
 * the process, not a reader. Actions read the host's amount as
 * `ctx.maxOutputBytes`.
 */
export const ACTION_MEMORY_BYTES = 8 * 1024 * 1024;

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/**
 * A new, unused path, `<dir>/<prefix>-<random hex><extension>`. `extension`
 * includes its dot. `dir` defaults to the system's temporary directory; a
 * directory that does not exist is the caller's error, and the engine
 * makes the one a host names before a run.
 */
function outputFilePath(
  prefix: string,
  extension: string,
  dir: string = tmpdir(),
): string {
  if (!/^[\w.-]+$/.test(prefix) || prefix.startsWith("."))
    throw new Error(`Invalid output file prefix: ${prefix}`);
  if (!/^(\.\w+)?$/.test(extension))
    throw new Error(`Invalid output file extension: ${extension}`);
  return join(dir, `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Write `data` to a new output file and answer its path. */
export function writeOutputFile(
  prefix: string,
  extension: string,
  data: string | Uint8Array,
  dir?: string,
): string {
  const path = outputFilePath(prefix, extension, dir);
  // `wx` never follows a link someone else placed at the path.
  writeFileSync(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
  return path;
}

/** Output goes to its file in blocks of this size, not a write per part taken. */
const BLOCK_BYTES = 64 * 1024;

/**
 * A new output file for output that arrives in parts. A file that cannot
 * be created or written does not stop its writer: the parts are then
 * dropped, and `close()` answers no path.
 */
export class OutputFileWriter {
  private readonly path: string;
  private readonly stream: WriteStream;
  private failed = false;
  /** What the file has not been handed yet. */
  private block: Buffer[] = [];
  private blockBytes = 0;

  constructor(prefix: string, extension: string, dir?: string) {
    this.path = outputFilePath(prefix, extension, dir);
    this.stream = createWriteStream(this.path, {
      mode: OUTPUT_FILE_MODE,
      flags: "wx",
    });
    this.stream.on("error", () => {
      this.failed = true;
    });
  }

  /**
   * Take more. Answers false when the file is behind: the writer waits for
   * `drained()` before it sends more, so that what arrives faster than the
   * disk takes is slowed instead of held in memory.
   */
  write(part: Uint8Array | string): boolean {
    if (this.failed) return true;
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    this.block.push(bytes);
    this.blockBytes += bytes.length;
    return this.blockBytes < BLOCK_BYTES || this.flush();
  }

  /** Resolves when the file has caught up, or has failed. */
  drained(): Promise<void> {
    const stream = this.stream;
    return stream.writableNeedDrain && !this.failed
      ? new Promise((resolve) => {
          const done = () => {
            stream.off("drain", done);
            stream.off("error", done);
            resolve();
          };
          stream.once("drain", done);
          stream.once("error", done);
        })
      : Promise.resolve();
  }

  /** Finish the file and answer its path, or nothing when it failed. */
  async close(): Promise<string | undefined> {
    this.flush();
    await this.end();
    if (!this.failed) return this.path;
    this.remove();
    return undefined;
  }

  /** Give the file up: what it was for did not come to an end. */
  async discard(): Promise<void> {
    this.block = [];
    await this.end();
    this.remove();
  }

  private flush(): boolean {
    const block = Buffer.concat(this.block);
    this.block = [];
    this.blockBytes = 0;
    return this.failed || !block.length ? true : this.stream.write(block);
  }

  private async end(): Promise<void> {
    const stream = this.stream;
    // `close` follows a finished file and a failed one alike.
    if (!stream.closed)
      await new Promise<void>((resolve) => {
        stream.once("close", () => resolve());
        stream.end();
      });
  }

  private remove(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // A path that cannot be reached holds no file to remove.
    }
  }
}
