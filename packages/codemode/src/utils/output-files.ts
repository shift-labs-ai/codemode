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
 * How much a run hands back to whoever asked for it: at most this many
 * lines and this many bytes, whichever is reached first. The rest is in an
 * output file. It is for the reader's sake, usually a model's, and a host
 * sets its own; what code inside a run works with is not held to it.
 */
export const OUTPUT_LIMIT = { lines: 2000, bytes: 50 * 1024 } as const;

export interface OutputLimit {
  lines: number;
  bytes: number;
}

/**
 * How much of what it produces one action holds in memory and hands to the
 * code that called it. Past it, an action that produces output in parts
 * keeps the rest in a file. It guards the process, not a reader.
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

/** How many lines `text` has. */
export function countLines(text: string): number {
  return linesOf(text).length;
}

/** The end of `line` that fits in `maxBytes`, cut between characters. */
function endOf(line: string, maxBytes: number): string {
  const bytes = Buffer.from(line, "utf8");
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** The start of `line` that fits in `maxBytes`, cut between characters. */
function startOf(line: string, maxBytes: number): string {
  // A streaming decode holds back a sequence the cut left unfinished.
  return new TextDecoder().decode(
    Buffer.from(line, "utf8").subarray(0, Math.max(0, maxBytes)),
    { stream: true },
  );
}

export interface Clipped {
  /** The lines kept, joined, with no line break after the last. */
  text: string;
  truncated: boolean;
  /** How many lines `text` has. */
  lines: number;
  /** Whether one of them is only part of a line too long to keep whole. */
  partialLine: boolean;
}

/** Whether `text` is within `limit` as it is. */
export function withinLimit(
  text: string,
  limit: OutputLimit = OUTPUT_LIMIT,
): boolean {
  return (
    Buffer.byteLength(text, "utf8") <= limit.bytes &&
    countLines(text) <= limit.lines
  );
}

/**
 * The first whole lines of `text` within `limit`. A first line that is over
 * the byte limit by itself is kept in part, from its start, so that the
 * answer is never empty.
 */
export function clipHead(
  text: string,
  limit: OutputLimit = OUTPUT_LIMIT,
): Clipped {
  const lines = linesOf(text);
  if (withinLimit(text, limit))
    return { text, truncated: false, lines: lines.length, partialLine: false };
  const kept: string[] = [];
  let bytes = 0;
  let partialLine = false;
  for (const line of lines) {
    if (kept.length >= limit.lines) break;
    const size = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (bytes + size > limit.bytes) {
      if (!kept.length) {
        kept.push(startOf(line, limit.bytes));
        partialLine = true;
      }
      break;
    }
    kept.push(line);
    bytes += size;
  }
  return {
    text: kept.join("\n"),
    truncated: true,
    lines: kept.length,
    partialLine,
  };
}

/**
 * The line that follows a clipped output and says what it shows of what
 * there was, and where the whole of it is when it was kept.
 */
export function clippedNote(
  clipped: Clipped,
  keeps: "first" | "last",
  total: { lines: number; bytes: number },
  path: string | undefined,
): string {
  const from = keeps === "first" ? 1 : total.lines - clipped.lines + 1;
  const shown = clipped.partialLine
    ? `Showing the ${keeps} ${formatSize(Buffer.byteLength(clipped.text, "utf8"))} of line ${from}`
    : `Showing lines ${from}-${from + clipped.lines - 1} of ${total.lines}`;
  return `[${shown} (${formatSize(total.bytes)} in all).${path ? ` Full output: ${path}` : ""}]`;
}

/**
 * The last whole lines of `text` within `limit`. A last line that is over
 * the byte limit by itself is kept in part, from its end, so that the
 * answer is never empty.
 */
export function clipTail(
  text: string,
  limit: OutputLimit = OUTPUT_LIMIT,
): Clipped {
  const lines = linesOf(text);
  if (withinLimit(text, limit))
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
