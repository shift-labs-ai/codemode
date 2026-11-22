/**
 * Output files: what codemode and its plugins write so that a caller can
 * reach output it was not handed in full, such as a command's whole output,
 * a run's whole result, or generated media. Every one is created here, in
 * the directory the host names, so where they are kept is decided in one
 * place. So is how much of an output is handed back before the rest goes
 * to a file.
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
 * How much of an output an action hands back: at most this many lines and
 * this many bytes, whichever is reached first. The rest is in an output
 * file. One rule for every action, so that code learns it once.
 */
export const OUTPUT_LIMIT = { lines: 2000, bytes: 50 * 1024 } as const;

export interface OutputLimit {
  lines: number;
  bytes: number;
}

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

/**
 * `text` within `maxBytes` of UTF-8: all of it, or its start and end around
 * a note of what lies between. It is cut between characters: a streaming
 * decode holds back an unfinished sequence at the end of the start, and the
 * end skips the rest of one.
 */
export function clipText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const head = bytes.subarray(0, half);
  const tail = bytes.subarray(bytes.length - (maxBytes - half));
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return {
    text: `${new TextDecoder().decode(head, { stream: true })}\n\n[... ${bytes.length - maxBytes} bytes omitted ...]\n\n${new TextDecoder().decode(tail.subarray(start))}`,
    truncated: true,
  };
}

/** A size as a person reads it: `512B`, `50.0KB`, `1.4MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The lines of `text`, without the empty one after a final line break. */
function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** The end of `line` that fits in `maxBytes`, cut between characters. */
function endOf(line: string, maxBytes: number): string {
  const bytes = Buffer.from(line, "utf8");
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

export interface ClippedTail {
  /** The lines kept, joined, with no line break after the last. */
  text: string;
  truncated: boolean;
  /** How many lines `text` has. */
  lines: number;
  /** Whether `text` starts with only the end of a line too long to keep whole. */
  partialLine: boolean;
}

/**
 * The last whole lines of `text` within `limit`. A last line that is over
 * the byte limit by itself is kept in part, from its end, so that the
 * answer is never empty.
 */
export function clipTail(
  text: string,
  limit: OutputLimit = OUTPUT_LIMIT,
): ClippedTail {
  const lines = linesOf(text);
  if (
    lines.length <= limit.lines &&
    Buffer.byteLength(text, "utf8") <= limit.bytes
  )
    return { text, truncated: false, lines: lines.length, partialLine: false };
  const kept: string[] = [];
  let bytes = 0;
  let partialLine = false;
  const blank = (line: string) => !line.trim();
  for (let index = lines.length - 1; index >= 0; index--) {
    if (kept.length >= limit.lines) break;
    const line = lines[index];
    const joint = kept.length ? 1 : 0;
    const size = Buffer.byteLength(line, "utf8") + joint;
    if (bytes + size > limit.bytes) {
      const room = limit.bytes - bytes - joint;
      if (!kept.length || (!blank(line) && kept.every(blank) && room > 0)) {
        kept.unshift(endOf(line, room));
        partialLine = true;
      }
      break;
    }
    kept.unshift(line);
    bytes += size;
  }
  return {
    text: kept.join("\n"),
    truncated: true,
    lines: kept.length,
    partialLine,
  };
}
