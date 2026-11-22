/**
 * Output files: what codemode and its plugins write so that a caller can
 * reach output it was not handed in full, such as a command's whole output,
 * a run's whole result, or generated media. Every one is created here, in
 * the directory the host names, so where they are kept is decided in one
 * place.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream, writeFileSync } from "node:fs";
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

/** Open a new output file for output that arrives in parts. */
export function createOutputFileStream(
  prefix: string,
  extension: string,
  dir?: string,
): { path: string; stream: WriteStream } {
  const path = outputFilePath(prefix, extension, dir);
  return {
    path,
    stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" }),
  };
}

/**
 * The start and the end of an output around a note of what lies between,
 * cut between characters: a streaming decode holds back an unfinished
 * sequence at the end of `head`, and `tail` skips the rest of one.
 */
export function joinClipped(
  head: Uint8Array,
  tail: Uint8Array,
  omittedBytes: number,
): string {
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return `${new TextDecoder().decode(head, { stream: true })}\n\n[... ${omittedBytes} bytes omitted ...]\n\n${new TextDecoder().decode(tail.subarray(start))}`;
}

/** `text` within `maxBytes` of UTF-8: all of it, or its start and end. */
export function clipText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  return {
    text: joinClipped(
      bytes.subarray(0, half),
      bytes.subarray(bytes.length - (maxBytes - half)),
      bytes.length - maxBytes,
    ),
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
