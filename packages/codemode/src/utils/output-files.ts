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
