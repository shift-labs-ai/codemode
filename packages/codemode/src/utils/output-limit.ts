/**
 * The output limit: how much a run hands back to whoever asked for it,
 * usually a model, and the one way text is cut to it. A text over the limit
 * keeps whole lines from one end and closes with a line that says which
 * lines they are and where all of it is.
 */

export interface OutputLimit {
  /** The most lines. */
  lines: number;
  /** The most bytes of UTF-8. */
  bytes: number;
}

/** The limit a run has unless its host sets another. */
export const OUTPUT_LIMIT: Readonly<OutputLimit> = Object.freeze({
  lines: 2000,
  bytes: 50 * 1024,
});

/**
 * The least a limit can be: room for one line of output, a blank line and
 * the closing line, with a path in it.
 */
export const MIN_OUTPUT_LIMIT: Readonly<OutputLimit> = Object.freeze({
  lines: 3,
  bytes: 1024,
});

/** The least room for output beside a closing line: with less, the line names no path. */
const LEAST_SHOWN_BYTES = 256;

/**
 * Whether `bytes` is a size a text can be cut to: a whole number with room
 * for some output beside its closing line.
 */
export function isOutputBytes(bytes: unknown): bytes is number {
  return (
    Number.isSafeInteger(bytes) && (bytes as number) >= MIN_OUTPUT_LIMIT.bytes
  );
}

/** A limit as a host sets it: either number alone, or `false` for none. */
export type OutputLimitSetting = Partial<OutputLimit> | false;

/**
 * The limit a setting stands for, `undefined` for none. Throws for a
 * setting that is not a limit.
 */
export function resolveOutputLimit(
  setting: OutputLimitSetting | undefined,
): OutputLimit | undefined {
  if (setting === false) return undefined;
  const limit = { ...OUTPUT_LIMIT, ...setting };
  if (
    !(
      Number.isSafeInteger(limit.lines) &&
      limit.lines >= MIN_OUTPUT_LIMIT.lines &&
      isOutputBytes(limit.bytes)
    )
  )
    throw new Error(
      `Invalid outputLimit: ${JSON.stringify(setting)}. Pass { lines, bytes } as whole numbers of at least ${MIN_OUTPUT_LIMIT.lines} lines and ${MIN_OUTPUT_LIMIT.bytes} bytes, or false for no limit.`,
    );
  return limit;
}

/** A size as a person reads it: `512B`, `50.0KB`, `1.4MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The lines of `text`, without the empty one after a final line break. */
function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** How many lines `text` has. A final line break ends a line and starts none. */
export function countLines(text: string): number {
  return linesOf(text).length;
}

/** Whether `text` is within `limit` as it is. */
export function withinLimit(text: string, limit: OutputLimit): boolean {
  return bytesOf(text) <= limit.bytes && countLines(text) <= limit.lines;
}

/** One end of `line` that fits in `maxBytes`, cut between characters. */
function endOfLine(
  line: string,
  maxBytes: number,
  keep: "first" | "last",
): string {
  const bytes = Buffer.from(line, "utf8");
  if (keep === "first")
    // A streaming decode holds back a sequence the cut left unfinished.
    return new TextDecoder().decode(bytes.subarray(0, Math.max(0, maxBytes)), {
      stream: true,
    });
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

interface KeptLines {
  lines: string[];
  /** How many blank lines were passed over before the first one kept. */
  skipped: number;
  /** Whether the line nearest the cut is only part of one too long to keep whole. */
  partial: boolean;
}

/**
 * Whole lines from one end of `lines`, as many as `limit` allows. Blank
 * lines at that end are passed over, and a first line too long to keep
 * whole is kept in part, so that what is shown is never empty or blank
 * while there is something to show. Lines that are all blank are kept as
 * they are.
 */
function keepLines(
  lines: string[],
  limit: OutputLimit,
  keep: "first" | "last",
): KeptLines {
  const ordered = keep === "first" ? lines : [...lines].reverse();
  const skipped = Math.max(
    0,
    ordered.findIndex((line) => line.trim()),
  );
  const kept: string[] = [];
  let bytes = 0;
  let partial = false;
  for (const line of ordered.slice(skipped)) {
    if (kept.length >= limit.lines) break;
    const joint = kept.length ? 1 : 0;
    const size = bytesOf(line) + joint;
    if (bytes + size > limit.bytes) {
      if (!kept.length) {
        kept.push(endOfLine(line, limit.bytes, keep));
        partial = true;
      }
      break;
    }
    kept.push(line);
    bytes += size;
  }
  return { lines: keep === "first" ? kept : kept.reverse(), skipped, partial };
}

/** The closing line of a cut text. */
function closingLine(
  shown: { from: number; count: number; partialBytes?: number },
  keep: "first" | "last",
  total: { lines: number; bytes: number },
  path: string | undefined,
): string {
  const what =
    shown.partialBytes === undefined
      ? `Showing lines ${shown.from}-${shown.from + shown.count - 1} of ${total.lines}`
      : `Showing the ${keep} ${formatSize(shown.partialBytes)} of line ${shown.from}`;
  return `[${what} (${formatSize(total.bytes)} in all).${path ? ` Full output: ${path}` : ""}]`;
}

export interface CutOptions {
  /** Which end of the text to keep. */
  keep: "first" | "last";
  /** The file that holds all of the text, for the closing line to name. */
  path?: string;
  /**
   * The size of all of the text, when `text` is only the end of it that
   * was kept. The text is then cut whether or not it fits.
   */
  total?: { lines: number; bytes: number };
}

export interface CutText {
  text: string;
  truncated: boolean;
}

/**
 * `text` within `limit`. A text that fits is itself. A longer one keeps
 * whole lines from one end and closes with a blank line and a line such as
 * `[Showing lines 1883-3120 of 3120 (212.4KB in all). Full output: /tmp/x.log]`,
 * all of it within the limit. `limit` is at least `MIN_OUTPUT_LIMIT`.
 */
export function cutText(
  text: string,
  limit: OutputLimit,
  options: CutOptions,
): CutText {
  const { keep } = options;
  if (!options.total && withinLimit(text, limit))
    return { text, truncated: false };
  const lines = linesOf(text);
  const total = options.total ?? { lines: lines.length, bytes: bytesOf(text) };
  // The closing line is as long as its numbers, so room is left for the
  // longest it can be. A path too long to fit beside any output is left
  // out: the result names the file as well.
  const longest = (path: string | undefined) =>
    Math.max(
      bytesOf(
        closingLine(
          { from: total.lines, count: total.lines },
          keep,
          total,
          path,
        ),
      ),
      bytesOf(
        closingLine(
          { from: total.lines, count: 1, partialBytes: 1023 * 1024 },
          keep,
          total,
          path,
        ),
      ),
    ) + 2;
  const path =
    limit.bytes - longest(options.path) >= LEAST_SHOWN_BYTES
      ? options.path
      : undefined;
  const kept = keepLines(
    lines,
    {
      lines: Math.max(1, limit.lines - 2),
      bytes: Math.max(1, limit.bytes - longest(path)),
    },
    keep,
  );
  const count = kept.lines.length;
  const from =
    keep === "first"
      ? kept.skipped + 1
      : total.lines - kept.skipped - count + 1;
  // A line kept in part is the one nearest the cut.
  const part = keep === "first" ? count - 1 : 0;
  return {
    text: `${kept.lines.join("\n")}\n\n${closingLine(
      kept.partial
        ? {
            from: from + part,
            count: 1,
            partialBytes: bytesOf(kept.lines[part]),
          }
        : { from, count },
      keep,
      total,
      path,
    )}`,
    truncated: true,
  };
}
