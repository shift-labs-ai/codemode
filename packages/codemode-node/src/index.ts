/**
 * Node for codemode: the host's files, paths, system facts, hashing and HTTP
 * as actions, so that code reaches them by name and each call is labelled
 * and reported.
 *
 *   const text = await node.fs.readFile({ path: "notes.txt" })
 *
 * Every call stands alone: nothing stays open between calls. A read or a
 * request that is under way ends with the run that started it, and a result
 * too large or not text to hand back is a file instead. Running a command
 * is the bash and powershell packages' work.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, type WriteStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  arch,
  cpus,
  EOL,
  freemem,
  homedir,
  hostname,
  platform,
  release,
  tmpdir,
  totalmem,
  type,
  uptime,
  userInfo,
} from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { finished } from "node:stream/promises";
import {
  type ActionContext,
  type CodemodePluginAPI,
  createOutputFileStream,
  writeOutputFile,
} from "@shiftlabs/codemode";
import { MAX_TIMEOUT_MS, packageVersion } from "@shiftlabs/codemode/utils/cli";
import * as t from "typebox";

/** The most a file read or a response body hands back in memory. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const OUTPUT_FILE_PREFIX = "codemode-node";

const strict = { additionalProperties: false } as const;

const path = (
  description = "A path. A relative one resolves from the connection's `cwd`.",
) => t.String({ minLength: 1, description });
const onePath = t.Object({ path: path() }, strict);
const fromTo = t.Object(
  { from: path("The source path."), to: path("The destination path.") },
  strict,
);
const segments = t.Object(
  {
    segments: t.Array(t.String(), { description: "Path segments, in order." }),
  },
  strict,
);
const maxBytes = (what: string, otherwise: string) =>
  t.Optional(
    t.Integer({
      minimum: 1,
      description: `The most bytes of ${what} to hand back. Default: ${DEFAULT_MAX_BYTES}. ${otherwise}`,
    }),
  );
const textEncoding = t.Optional(
  t.Union(
    [
      t.Literal("utf8"),
      t.Literal("base64"),
      t.Literal("hex"),
      t.Literal("latin1"),
      t.Literal("utf16le"),
    ],
    { description: "How the text is encoded. Default: utf8." },
  ),
);
const digestEncoding = t.Optional(
  t.Union([t.Literal("hex"), t.Literal("base64"), t.Literal("base64url")], {
    description: "How the bytes are written. Default: hex.",
  }),
);

/** The directory relative paths resolve from: the connection's `cwd`, else codemode's own. */
function base(ctx: ActionContext): string {
  const { cwd } = ctx.connection.config;
  return typeof cwd === "string" && cwd ? resolve(cwd) : process.cwd();
}

function at(ctx: ActionContext, path: string): string {
  return resolve(base(ctx), path);
}

function describeStats(stats: Awaited<ReturnType<typeof stat>>) {
  return {
    size: stats.size,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    isBlockDevice: stats.isBlockDevice(),
    isCharacterDevice: stats.isCharacterDevice(),
    isFIFO: stats.isFIFO(),
    isSocket: stats.isSocket(),
  };
}

/** Whether a response says its body is text. */
function saysText(contentType: string): boolean {
  return /^text\/|[/+](json|xml)\b|javascript|x-www-form-urlencoded/i.test(
    contentType,
  );
}

/** The extension of the file a response body is kept in: the URL's own, when it has a plain one. */
function bodyExtension(url: string, contentType: string): string {
  if (/[/+]json\b/i.test(contentType)) return ".json";
  const named = extname(new URL(url).pathname);
  if (/^\.\w{1,8}$/.test(named)) return named;
  return saysText(contentType) ? ".txt" : ".bin";
}

async function write(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolved, rejected) => {
    stream.once("drain", resolved);
    stream.once("error", rejected);
  });
}

/**
 * A response's body: as text when it is text within `limit`, and otherwise
 * all of it in an output file. A body is never handed back in part.
 */
async function readBody(
  response: Response,
  url: string,
  limit: number,
  outputDir: string | undefined,
): Promise<{ body?: unknown; bodyPath?: string; bytes: number }> {
  const contentType = response.headers.get("content-type") ?? "";
  const extension = bodyExtension(url, contentType);
  const held: Uint8Array[] = [];
  let bytes = 0;
  let file: ReturnType<typeof createOutputFileStream> | undefined;
  try {
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (!file) {
        held.push(chunk);
        if (bytes <= limit) continue;
        file = createOutputFileStream(OUTPUT_FILE_PREFIX, extension, outputDir);
        for (const earlier of held.splice(0)) await write(file.stream, earlier);
        continue;
      }
      await write(file.stream, chunk);
    }
    if (file) {
      file.stream.end();
      await finished(file.stream);
      return { bodyPath: file.path, bytes };
    }
  } catch (error) {
    if (file) {
      file.stream.destroy();
      rmSync(file.path, { force: true });
    }
    throw error;
  }
  const whole = Buffer.concat(held);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(whole);
  } catch {
    return {
      bodyPath: writeOutputFile(
        OUTPUT_FILE_PREFIX,
        extension,
        whole,
        outputDir,
      ),
      bytes,
    };
  }
  if (/[/+]json\b/i.test(contentType)) {
    try {
      return { body: JSON.parse(text), bytes };
    } catch {
      // A body that says JSON and is not: its text is the truth.
    }
  }
  return { body: text, bytes };
}

export default function node(rl: CodemodePluginAPI): void {
  rl.setName("node");
  rl.setVersion(packageVersion(import.meta.url));
  rl.setDescription(
    "Read and write files, work with paths, read system facts, hash, and make HTTP requests on the machine codemode runs on, with the permissions of the codemode process.",
  );
  rl.setConnectionSchema(
    t.Object({
      cwd: t.Optional(
        t.String({
          description:
            "The directory relative paths resolve from. Default: the directory codemode runs in.",
        }),
      ),
    }),
  );

  // Files

  rl.registerAction("fs.readFile", {
    access: "read",
    description:
      "Read a file as text. A file larger than `maxBytes` is refused, with its size.",
    inputSchema: t.Object(
      {
        path: path(),
        encoding: textEncoding,
        maxBytes: maxBytes(
          "the file",
          "Read a larger file in parts with bash, or query it with duckdb.",
        ),
      },
      strict,
    ),
    async execute({ path, encoding = "utf8", maxBytes }, ctx) {
      const file = at(ctx, path);
      const limit = maxBytes ?? DEFAULT_MAX_BYTES;
      const { size } = await stat(file);
      if (size > limit)
        throw new Error(
          `node: ${file} is ${size} bytes, over the limit of ${limit}. Pass a larger maxBytes, or read it in parts another way.`,
        );
      return readFile(file, { encoding, signal: ctx.signal });
    },
  });

  for (const [name, flag, description] of [
    ["fs.writeFile", "w", "Write text to a file, replacing what it held."],
    ["fs.appendFile", "a", "Add text to the end of a file."],
  ] as const)
    rl.registerAction(name, {
      access: "write",
      description,
      hints: { destructive: flag === "w" },
      inputSchema: t.Object(
        {
          path: path(),
          data: t.String({ description: "The text to write." }),
          encoding: textEncoding,
        },
        strict,
      ),
      async execute({ path, data, encoding = "utf8" }, ctx) {
        const file = at(ctx, path);
        await writeFile(file, data, { encoding, flag, signal: ctx.signal });
        return { ok: true, path: file };
      },
    });

  rl.registerAction("fs.readdir", {
    access: "read",
    description: "List the names in a directory.",
    inputSchema: t.Object(
      {
        path: path(),
        withFileTypes: t.Optional(
          t.Boolean({
            description: "Return each entry with its kind instead of names.",
          }),
        ),
      },
      strict,
    ),
    async execute({ path, withFileTypes = false }, ctx) {
      const directory = at(ctx, path);
      if (!withFileTypes) return readdir(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    },
  });

  rl.registerAction("fs.stat", {
    access: "read",
    description: "Describe what a path leads to: size, times, mode and kind.",
    inputSchema: onePath,
    execute: async ({ path }, ctx) => describeStats(await stat(at(ctx, path))),
  });

  rl.registerAction("fs.lstat", {
    access: "read",
    description: "Describe a path itself, without following a symbolic link.",
    inputSchema: onePath,
    execute: async ({ path }, ctx) => describeStats(await lstat(at(ctx, path))),
  });

  rl.registerAction("fs.exists", {
    access: "read",
    description: "Whether a path exists.",
    inputSchema: onePath,
    execute: ({ path }, ctx) => existsSync(at(ctx, path)),
  });

  rl.registerAction("fs.access", {
    access: "read",
    description: "Check that a path can be reached. Rejects when it cannot.",
    inputSchema: onePath,
    async execute({ path }, ctx) {
      await access(at(ctx, path));
      return { ok: true };
    },
  });

  rl.registerAction("fs.mkdir", {
    access: "write",
    description: "Create a directory.",
    inputSchema: t.Object(
      {
        path: path(),
        recursive: t.Optional(
          t.Boolean({ description: "Create missing parents. Default: true." }),
        ),
      },
      strict,
    ),
    async execute({ path, recursive = true }, ctx) {
      const directory = at(ctx, path);
      await mkdir(directory, { recursive });
      return { ok: true, path: directory };
    },
  });

  rl.registerAction("fs.rm", {
    access: "write",
    description: "Remove a file or a directory.",
    hints: { destructive: true },
    inputSchema: t.Object(
      {
        path: path(),
        recursive: t.Optional(
          t.Boolean({
            description:
              "Remove a directory and what it holds. Default: false.",
          }),
        ),
        force: t.Optional(
          t.Boolean({
            description: "Succeed when the path is missing. Default: false.",
          }),
        ),
      },
      strict,
    ),
    async execute({ path, recursive = false, force = false }, ctx) {
      const target = at(ctx, path);
      await rm(target, { recursive, force });
      return { ok: true, path: target };
    },
  });

  rl.registerAction("fs.unlink", {
    access: "write",
    description: "Remove a file.",
    hints: { destructive: true },
    inputSchema: onePath,
    async execute({ path }, ctx) {
      const file = at(ctx, path);
      await unlink(file);
      return { ok: true, path: file };
    },
  });

  for (const [name, move, description] of [
    ["fs.rename", rename, "Move or rename a file or a directory."],
    ["fs.copyFile", copyFile, "Copy a file, replacing the destination."],
  ] as const)
    rl.registerAction(name, {
      access: "write",
      description,
      hints: { destructive: true },
      inputSchema: fromTo,
      async execute(input, ctx) {
        const from = at(ctx, input.from);
        const to = at(ctx, input.to);
        await move(from, to);
        return { ok: true, from, to };
      },
    });

  // Paths

  rl.registerAction("path.join", {
    access: "read",
    description: "Join path segments.",
    inputSchema: segments,
    execute: ({ segments }) => join(...segments),
  });

  rl.registerAction("path.resolve", {
    access: "read",
    description:
      "Resolve path segments to an absolute path, from the connection's `cwd`.",
    inputSchema: segments,
    execute: ({ segments }, ctx) => resolve(base(ctx), ...segments),
  });

  for (const [name, change, description] of [
    ["path.normalize", normalize, "Normalize a path."],
    ["path.dirname", dirname, "The directory part of a path."],
    ["path.extname", extname, "The extension of a path."],
    ["path.isAbsolute", isAbsolute, "Whether a path is absolute."],
    ["path.parse", parse, "The parts of a path."],
  ] as const)
    rl.registerAction(name, {
      access: "read",
      description,
      inputSchema: t.Object({ path: path("A path.") }, strict),
      execute: ({ path }) => change(path),
    });

  rl.registerAction("path.basename", {
    access: "read",
    description: "The last part of a path.",
    inputSchema: t.Object(
      {
        path: path("A path."),
        suffix: t.Optional(
          t.String({ description: "An ending to leave off, such as `.txt`." }),
        ),
      },
      strict,
    ),
    execute: ({ path, suffix }) => basename(path, suffix),
  });

  rl.registerAction("path.relative", {
    access: "read",
    description: "The path from one path to another.",
    inputSchema: fromTo,
    execute: ({ from, to }, ctx) => relative(at(ctx, from), at(ctx, to)),
  });

  rl.registerAction("path.format", {
    access: "read",
    description: "Build a path from its parts, as `path.parse` returns them.",
    inputSchema: t.Object(
      {
        pathObject: t.Object(
          {
            root: t.Optional(t.String()),
            dir: t.Optional(t.String()),
            base: t.Optional(t.String()),
            name: t.Optional(t.String()),
            ext: t.Optional(t.String()),
          },
          strict,
        ),
      },
      strict,
    ),
    execute: ({ pathObject }) => format(pathObject),
  });

  rl.registerAction("path.constants", {
    access: "read",
    description: "The host's path separator and `PATH` delimiter.",
    execute: () => ({ sep, delimiter }),
  });

  // The system and the process

  rl.registerAction("os.info", {
    access: "read",
    description: "Facts about the host: platform, memory, processors.",
    execute: () => ({
      platform: platform(),
      arch: arch(),
      type: type(),
      release: release(),
      hostname: hostname(),
      homedir: homedir(),
      tmpdir: tmpdir(),
      uptime: uptime(),
      totalmem: totalmem(),
      freemem: freemem(),
      eol: EOL,
      cpus: cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })),
    }),
  });

  for (const [name, read, description] of [
    ["os.platform", platform, "The host's platform, such as `linux`."],
    ["os.arch", arch, "The host's processor architecture."],
    ["os.homedir", homedir, "The user's home directory."],
    ["os.tmpdir", tmpdir, "The directory for temporary files."],
  ] as const)
    rl.registerAction(name, {
      access: "read",
      description,
      execute: () => read(),
    });

  rl.registerAction("os.userInfo", {
    access: "read",
    description: "The user codemode runs as.",
    execute() {
      const { username, uid, gid, shell, homedir } = userInfo();
      return { username, uid, gid, shell, homedir };
    },
  });

  rl.registerAction("process.cwd", {
    access: "read",
    description:
      "The directory relative paths resolve from: the connection's `cwd`, else the one codemode runs in.",
    execute: (_input, ctx) => base(ctx),
  });

  rl.registerAction("process.env", {
    access: "read",
    description:
      "Read the environment of the codemode process: one variable, or all of them.",
    inputSchema: t.Object(
      {
        name: t.Optional(
          t.String({
            minLength: 1,
            description: "The variable. Default: every variable.",
          }),
        ),
      },
      strict,
    ),
    execute: ({ name }) => (name ? process.env[name] : { ...process.env }),
  });

  // Hashing and random values

  rl.registerAction("crypto.randomUUID", {
    access: "read",
    description: "A random UUID.",
    execute: () => randomUUID(),
  });

  rl.registerAction("crypto.randomBytes", {
    access: "read",
    description: "Cryptographically strong random bytes, written as text.",
    inputSchema: t.Object(
      {
        size: t.Integer({
          minimum: 1,
          maximum: 65_536,
          description: "How many bytes.",
        }),
        encoding: digestEncoding,
      },
      strict,
    ),
    execute: ({ size, encoding = "hex" }) =>
      randomBytes(size).toString(encoding),
  });

  rl.registerAction("crypto.hash", {
    access: "read",
    description: "Hash text.",
    inputSchema: t.Object(
      {
        data: t.String({ description: "The text to hash." }),
        algorithm: t.Optional(
          t.String({
            minLength: 1,
            description:
              "A digest algorithm the host's OpenSSL has. Default: sha256.",
          }),
        ),
        encoding: digestEncoding,
      },
      strict,
    ),
    execute: ({ data, algorithm = "sha256", encoding = "hex" }) =>
      createHash(algorithm).update(data).digest(encoding),
  });

  // HTTP

  rl.registerAction("fetch", {
    access: "write",
    description:
      "Make an HTTP request. A text body within `maxBytes` returns as `body`, parsed when it is JSON. Any other body is written whole to a file, named by `bodyPath`.",
    hints: { openWorld: true },
    inputSchema: t.Object(
      {
        url: t.String({ minLength: 1, description: "The URL." }),
        method: t.Optional(t.String({ description: "Default: GET." })),
        headers: t.Optional(t.Record(t.String(), t.String())),
        body: t.Optional(t.String({ description: "The request's body." })),
        timeoutMs: t.Optional(
          t.Integer({
            minimum: 1,
            maximum: MAX_TIMEOUT_MS,
            description:
              "Give up after this many milliseconds. Default: no limit of its own; the request ends when the run does.",
          }),
        ),
        maxBytes: maxBytes(
          "the response body",
          "A larger body is written to a file.",
        ),
      },
      strict,
    ),
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        status: { type: "number" },
        statusText: { type: "string" },
        headers: { type: "object" },
        body: {
          description: "The body, when it is text within `maxBytes`.",
        },
        bodyPath: {
          type: "string",
          description: "The file with all of the body, when `body` is absent.",
        },
        bytes: { type: "number", description: "The body's size." },
      },
      required: ["ok", "status", "statusText", "headers", "bytes"],
    },
    async execute({ url, method, headers, body, timeoutMs, maxBytes }, ctx) {
      const ends = [
        ctx.signal,
        timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      ].filter((signal) => signal !== undefined);
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.any(ends),
      });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        ...(await readBody(
          response,
          url,
          maxBytes ?? DEFAULT_MAX_BYTES,
          ctx.outputDir,
        )),
      };
    },
  });
}
