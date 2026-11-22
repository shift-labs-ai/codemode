/**
 * What a run hands back, within the output limit. A run's result, its
 * error and its logs go to whoever asked for the run, usually a model, and
 * each is cut to the limit there. What is cut is written whole to an output
 * file first, and the cut text ends with a line that names the file.
 */

import {
  type Clipped,
  clipHead,
  clippedNote,
  clipTail,
  countLines,
  OUTPUT_LIMIT,
  type OutputLimit,
  withinLimit,
  writeOutputFile,
} from "../utils/output-files.js";

/** A limit as a host sets it: either number alone, or `false` for none. */
export type OutputLimitSetting = Partial<OutputLimit> | false;

/**
 * The limit a setting stands for, `undefined` for none. Throws for a
 * setting that is not one.
 */
export function resolveOutputLimit(
  setting: OutputLimitSetting | undefined,
): OutputLimit | undefined {
  if (setting === false) return undefined;
  const limit = { ...OUTPUT_LIMIT, ...setting };
  for (const size of [limit.lines, limit.bytes])
    if (!(Number.isSafeInteger(size) && size > 0))
      throw new Error(
        `Invalid outputLimit: ${JSON.stringify(setting)}. Pass { lines, bytes } as whole numbers above 0, or false for no limit.`,
      );
  return limit;
}

/** Room a note takes at the end of a clipped text: two lines, and its words with a path. */
const NOTE = { lines: 2, bytes: 512 };

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Write `text` to an output file. A file that cannot be written is gone without. */
function kept(
  prefix: string,
  extension: string,
  text: string,
  dir: string | undefined,
): string | undefined {
  try {
    return writeOutputFile(prefix, extension, text, dir);
  } catch {
    return undefined;
  }
}

/** `text` cut to `limit` with its note inside the limit. */
function clipped(
  text: string,
  limit: OutputLimit,
  keeps: "first" | "last",
  path: string | undefined,
): { shown: Clipped; note: string } {
  const room = {
    lines: Math.max(1, limit.lines - NOTE.lines),
    bytes: Math.max(1, limit.bytes - NOTE.bytes),
  };
  const shown = (keeps === "first" ? clipHead : clipTail)(text, room);
  return {
    shown,
    note: clippedNote(
      shown,
      keeps,
      { lines: countLines(text), bytes: bytesOf(text) },
      path,
    ),
  };
}

function clippedText(
  text: string,
  limit: OutputLimit,
  keeps: "first" | "last",
  path: string | undefined,
): string {
  const { shown, note } = clipped(text, limit, keeps, path);
  return `${shown.text.replace(/\n$/, "")}\n\n${note}`;
}

interface StringLeaf {
  path: (string | number)[];
  value: string;
}

function stringLeaves(
  value: unknown,
  path: (string | number)[] = [],
): StringLeaf[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value))
    return value.flatMap((item, index) => stringLeaves(item, [...path, index]));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      stringLeaves(item, [...path, key]),
    );
  return [];
}

/** The lines a string adds to a result beyond the one its JSON takes. */
function innerLines(text: string): number {
  return Math.max(0, countLines(text) - 1);
}

export interface BoundedResult {
  result: unknown;
  truncated?: true;
  fullResultPath?: string;
}

/**
 * A run's result within `limit`. A result that fits is itself. Of one that
 * does not:
 *
 * - a string is its last lines;
 * - a value made too large by one string in it, such as a command's output
 *   beside its exit code, keeps its shape with that string cut to its last
 *   lines;
 * - any other value is the first lines of its JSON, and so is text.
 */
export function boundResult(
  result: unknown,
  limit: OutputLimit,
  outputDir: string | undefined,
): BoundedResult {
  if (result === undefined || result === null) return { result };
  const isText = typeof result === "string";
  const text = isText ? result : JSON.stringify(result, null, 2);
  const leaves = isText ? [] : stringLeaves(result);
  const lines =
    countLines(text) +
    leaves.reduce((sum, leaf) => sum + innerLines(leaf.value), 0);
  if (bytesOf(text) <= limit.bytes && lines <= limit.lines) return { result };

  const path = kept(
    "codemode-result",
    isText ? ".txt" : ".json",
    text,
    outputDir,
  );
  const cut = (shown: unknown): BoundedResult => ({
    result: shown,
    truncated: true,
    ...(path ? { fullResultPath: path } : {}),
  });
  if (isText) return cut(clippedText(text, limit, "last", path));

  const [largest] = leaves.sort((a, b) => bytesOf(b.value) - bytesOf(a.value));
  if (largest) {
    // What the rest of the result takes is what the string may not.
    let room = {
      lines: limit.lines - (lines - innerLines(largest.value)) + 1,
      bytes:
        limit.bytes - (bytesOf(text) - bytesOf(JSON.stringify(largest.value))),
    };
    // A string takes more as JSON than as itself, by its escapes, so the
    // room is narrowed until the cut string fits as JSON.
    for (
      let tries = 0;
      tries < 8 && room.lines > NOTE.lines && room.bytes > NOTE.bytes * 2;
      tries++
    ) {
      const shown = clippedText(largest.value, room, "last", path);
      const over = bytesOf(JSON.stringify(shown)) - room.bytes;
      if (over <= 0) {
        const copy = JSON.parse(text);
        let holder = copy;
        for (const key of largest.path.slice(0, -1)) holder = holder[key];
        holder[largest.path.at(-1) as string | number] = shown;
        return cut(copy);
      }
      room = { ...room, bytes: room.bytes - over };
    }
  }
  return cut(clippedText(text, limit, "first", path));
}

/** A run's error within `limit`: its last lines, where what went wrong is. */
export function boundError(
  error: string,
  limit: OutputLimit,
  outputDir: string | undefined,
): string {
  if (withinLimit(error, limit)) return error;
  return clippedText(
    error,
    limit,
    "last",
    kept("codemode-error", ".txt", error, outputDir),
  );
}

/** A run's logs within `limit`: the last of them, and then a line that says so. */
export function boundLogs(
  logs: string[],
  limit: OutputLimit,
  outputDir: string | undefined,
): string[] {
  const text = logs.join("\n");
  if (withinLimit(text, limit)) return logs;
  const { shown, note } = clipped(
    text,
    limit,
    "last",
    kept("codemode-logs", ".log", text, outputDir),
  );
  return [...shown.text.split("\n"), note];
}
