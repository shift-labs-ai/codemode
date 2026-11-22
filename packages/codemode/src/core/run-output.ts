/**
 * What a run hands back, within the output limit. A run's result, its
 * error and its logs go to whoever asked for the run, usually a model, and
 * each is cut to the limit here. What is cut is written whole to an output
 * file first.
 */

import { writeOutputFile } from "../utils/output-files.js";
import {
  countLines,
  cutText,
  MIN_OUTPUT_LIMIT,
  type OutputLimit,
  withinLimit,
} from "../utils/output-limit.js";

/** What a run produced, before or after it is cut. */
export interface RunOutput {
  result: unknown;
  error?: string;
  logs: string[];
  /** Present when `result` is cut from a larger one. */
  truncated?: true;
  /** The file holding the whole result, when `result` does not. */
  fullResultPath?: string;
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Write `text` to an output file. A file that cannot be written is gone without. */
function keep(
  name: string,
  extension: string,
  text: string,
  outputDir: string | undefined,
): string | undefined {
  try {
    return writeOutputFile(`codemode-${name}`, extension, text, outputDir);
  } catch {
    return undefined;
  }
}

/** A string somewhere in a value, and how to put another in its place. */
interface StringLeaf {
  value: string;
  replace(value: string): void;
}

function stringLeaves(value: unknown): StringLeaf[] {
  const found: StringLeaf[] = [];
  const visit = (holder: Record<string | number, unknown>) => {
    for (const [key, item] of Object.entries(holder))
      if (typeof item === "string")
        found.push({
          value: item,
          replace: (other) => {
            holder[key] = other;
          },
        });
      else if (item && typeof item === "object")
        visit(item as Record<string | number, unknown>);
  };
  if (value && typeof value === "object")
    visit(value as Record<string | number, unknown>);
  return found;
}

/**
 * A value within `limit` with its shape kept, by cutting strings in it to
 * their last lines, or nothing when that is not enough. A string is held
 * to the line limit by itself, and the largest one gives up what the value
 * is over in bytes. This is what keeps a command's output beside its exit
 * code, instead of turning both into text.
 */
function withStringsCut(
  json: string,
  limit: OutputLimit,
  path: string | undefined,
): unknown {
  const copy = JSON.parse(json);
  const leaves = stringLeaves(copy);
  for (const leaf of leaves)
    if (countLines(leaf.value) > limit.lines)
      leaf.replace(cutText(leaf.value, limit, { keep: "last", path }).text);
  const size = () => bytesOf(JSON.stringify(copy, null, 2));
  // Cutting strings takes no lines from a value's JSON.
  if (countLines(json) > limit.lines) return undefined;
  if (size() <= limit.bytes) return copy;

  const [largest] = [...leaves].sort(
    (a, b) => bytesOf(b.value) - bytesOf(a.value),
  );
  if (!largest) return undefined;
  // What the rest of the value takes is what the string may not. A string
  // takes more as JSON than as itself, by its escapes, so its room is
  // narrowed until the value fits.
  largest.replace("");
  let room = limit.bytes - size();
  for (let tries = 0; tries < 8 && room >= MIN_OUTPUT_LIMIT.bytes; tries++) {
    largest.replace(
      cutText(
        largest.value,
        { lines: limit.lines, bytes: room },
        { keep: "last", path },
      ).text,
    );
    const over = size() - limit.bytes;
    if (over <= 0) return copy;
    room -= over;
  }
  return undefined;
}

/** Whether a value is within `limit`: its JSON, and each string in it by its own lines. */
function valueFits(json: string, value: unknown, limit: OutputLimit): boolean {
  return (
    withinLimit(json, limit) &&
    stringLeaves(value).every((leaf) => countLines(leaf.value) <= limit.lines)
  );
}

function boundResult(
  result: unknown,
  limit: OutputLimit,
  outputDir: string | undefined,
): Pick<RunOutput, "result" | "truncated" | "fullResultPath"> {
  const isText = typeof result === "string";
  const text = isText ? result : JSON.stringify(result, null, 2);
  // Nothing, and what JSON has no text for, is handed back as it is.
  if (result === null || text === undefined) return { result };
  if (isText ? withinLimit(text, limit) : valueFits(text, result, limit))
    return { result };

  const path = keep("result", isText ? ".txt" : ".json", text, outputDir);
  return {
    result: isText
      ? cutText(text, limit, { keep: "last", path }).text
      : (withStringsCut(text, limit, path) ??
        cutText(text, limit, {
          keep: "first",
          path,
          // Cut whether or not the JSON fits: it is here because the value does not.
          total: { lines: countLines(text), bytes: bytesOf(text) },
        }).text),
    truncated: true,
    ...(path ? { fullResultPath: path } : {}),
  };
}

/** A text's last lines within `limit`, with all of it in a file. */
function boundText(
  text: string,
  limit: OutputLimit,
  file: { name: string; extension: string },
  outputDir: string | undefined,
): string {
  // The file is written only for a text that is cut.
  if (withinLimit(text, limit)) return text;
  return cutText(text, limit, {
    keep: "last",
    path: keep(file.name, file.extension, text, outputDir),
  }).text;
}

/**
 * What a run produced, within `limit`.
 *
 * A result that fits is itself. Of one that does not:
 *
 * - a string is its last lines;
 * - a value that fits once strings in it are cut to their last lines keeps
 *   its shape;
 * - any other value is the first lines of its JSON, and so is text.
 *
 * An error and the logs each keep their last lines. Whatever is cut is
 * written whole to a file in `outputDir`, and closes with a line that names
 * the file.
 */
export function boundRun(
  run: RunOutput,
  limit: OutputLimit,
  outputDir: string | undefined,
): RunOutput {
  const logs = run.logs.join("\n");
  const boundLogs = boundText(
    logs,
    limit,
    { name: "logs", extension: ".log" },
    outputDir,
  );
  return {
    ...run,
    ...(run.error === undefined
      ? boundResult(run.result, limit, outputDir)
      : {
          error: boundText(
            run.error,
            limit,
            { name: "error", extension: ".txt" },
            outputDir,
          ),
        }),
    logs: boundLogs === logs ? run.logs : boundLogs.split("\n"),
  };
}
