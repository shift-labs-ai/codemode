import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  type CommandRunner,
  failureDetail,
  nodeCommandRunner,
} from "../packages/runner.js";
import type { PluginDef } from "../plugin/types.js";
import { inheritedEnvironment } from "../utils/environment.js";
import {
  type BinaryArtifact,
  type BinaryDeclaration,
  type BinaryFormat,
  type BinarySummary,
  binaryArtifact,
  isArchive,
  summarizeBinary,
} from "./declaration.js";

export type BinaryErrorCode =
  | "not_declared"
  | "unsupported_platform"
  | "not_installed"
  | "offline"
  | "download_failed"
  | "unpack_failed"
  | "check_failed"
  | "aborted";

export class BinaryError extends Error {
  readonly code: BinaryErrorCode;

  constructor(code: BinaryErrorCode, message: string) {
    super(message);
    this.name = "BinaryError";
    this.code = code;
  }
}

/** A binary on this host: what its declaration says, and whether it is installed. */
export interface BinaryStatus extends BinarySummary {
  installed: boolean;
  /** The program, when it is installed. */
  path?: string;
}

/** A binary as the plugin that declares it names it. */
export interface PluginBinary extends BinaryStatus {
  plugin: string;
  name: string;
}

export interface BinaryManagerOptions {
  /**
   * The folder installed binaries are kept in, or a function that names it
   * when a binary is first asked about.
   */
  dir: string | (() => string);
  /** Downloads artifacts. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Runs `tar` and `unzip`, and a binary's own check. Default: argv spawns
   * through `node:child_process`.
   */
  runner?: CommandRunner;
  /** Refuse every download. */
  offline?: boolean;
  /** Called when a binary's download is about to start. */
  onDownload?: (name: string, binary: BinarySummary) => void;
}

export interface BinaryCallOptions {
  signal?: AbortSignal;
}

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const UNPACK_TIMEOUT_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30 * 1000;

/** The format a download's name suggests, longest suffix first. */
const ARCHIVE_SUFFIXES: ReadonlyArray<[suffix: string, format: BinaryFormat]> =
  [
    [".tar.gz", "tar.gz"],
    [".tgz", "tar.gz"],
    [".tar.bz2", "tar.bz2"],
    [".tar.xz", "tar.xz"],
    [".tar.zst", "tar.zst"],
    [".tar", "tar"],
    [".zip", "zip"],
    [".gz", "gz"],
  ];

/** bsdtar, which Windows ships and which unpacks zip. Git's GNU tar on PATH does not. */
function windowsTar(): string {
  const system = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "tar.exe",
  );
  return existsSync(system) ? system : "tar.exe";
}

/**
 * Installs the programs plugins declare and says where they are. The CLI is
 * one consumer; a host embeds it with its own folder, `fetch` and runner.
 * It downloads only when `install` or `describe` is called, and never
 * prompts or prints.
 *
 * A binary's folder is named for what its declaration pins (size, digest,
 * format), so one declaration is one folder: two plugins declaring the same
 * build share it, and two versions sit side by side.
 */
export class BinaryManager {
  private readonly named: string | (() => string);
  private resolved: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly runner: CommandRunner;
  private readonly offline: boolean;
  private readonly onDownload: BinaryManagerOptions["onDownload"];

  constructor(options: BinaryManagerOptions) {
    this.named = options.dir;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.runner = options.runner ?? nodeCommandRunner;
    this.offline = options.offline === true;
    this.onDownload = options.onDownload;
  }

  /** What a declaration says of this host, and whether its binary is installed. */
  status(binary: BinaryDeclaration): BinaryStatus {
    const artifact = binaryArtifact(binary);
    const program = artifact && this.program(artifact);
    const installed = program !== undefined && existsSync(program);
    return {
      ...summarizeBinary(binary),
      installed,
      ...(installed ? { path: program } : {}),
    };
  }

  /**
   * Download this host's build of a binary, verify it against the declared
   * size and SHA-256, unpack it, run its check, and only then put it in
   * place. Answers the program's path. A binary already installed is left
   * as it is.
   */
  async install(
    name: string,
    binary: BinaryDeclaration,
    options: BinaryCallOptions = {},
  ): Promise<string> {
    const status = this.status(binary);
    if (status.path) return status.path;
    const artifact = binaryArtifact(binary);
    if (!artifact)
      throw new BinaryError(
        "unsupported_platform",
        `${name} has no build for this platform (${status.platform})`,
      );
    if (this.offline)
      throw new BinaryError(
        "offline",
        `${name} was not installed: binaries are not downloaded while codemode is offline`,
      );
    this.onDownload?.(name, status);
    const { signal } = options;
    await mkdir(this.dir, { recursive: true });
    // Beside the final folder, so that putting the binary in place is a rename.
    const work = await mkdtemp(join(this.dir, ".install-"));
    try {
      const download = join(work, "download");
      const tree = join(work, "tree");
      await this.download(name, artifact, download, signal);
      await mkdir(tree);
      const program = await this.unpack(name, artifact, download, tree, signal);
      if (binary.check) await this.check(name, program, binary.check, signal);
      try {
        await rename(tree, this.folder(artifact));
      } catch (error) {
        // Another install of the same build got there first.
        if (!existsSync(this.program(artifact))) throw error;
      }
      return this.program(artifact);
    } catch (error) {
      if (signal?.aborted)
        throw new BinaryError("aborted", `Installing ${name} was aborted`);
      throw error;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Delete an installed binary. Answers whether there was one. */
  async remove(binary: BinaryDeclaration): Promise<boolean> {
    const artifact = binaryArtifact(binary);
    if (!artifact || !existsSync(this.program(artifact))) return false;
    await rm(this.folder(artifact), { recursive: true, force: true });
    return true;
  }

  /**
   * A platform entry for the artifact at `url`: its size and SHA-256 as it
   * downloads now, and the format its name suggests. The declaration's
   * author adds `path`.
   */
  async describe(
    url: string,
    options: BinaryCallOptions = {},
  ): Promise<BinaryArtifact> {
    if (this.offline)
      throw new BinaryError(
        "offline",
        "Nothing is downloaded while codemode is offline",
      );
    const source = URL.canParse(url) ? new URL(url) : undefined;
    if (source?.protocol !== "https:")
      throw new BinaryError("download_failed", `Not an https URL: ${url}`);
    const measured = await this.read(source.href, {
      signal: options.signal,
    }).catch((error) => {
      throw new BinaryError(
        "download_failed",
        `Could not download ${source.href}: ${(error as Error).message}`,
      );
    });
    const format = ARCHIVE_SUFFIXES.find(([suffix]) =>
      source.pathname.endsWith(suffix),
    )?.[1];
    return {
      size: measured.size,
      hash: "sha256",
      digest: measured.digest,
      ...(format ? { format } : {}),
      path: "",
      providers: [{ url: source.href }],
    };
  }

  // ── where things are ──────────────────────────────────

  private get dir(): string {
    this.resolved ??=
      typeof this.named === "function" ? this.named() : this.named;
    return this.resolved;
  }

  private folder(artifact: BinaryArtifact): string {
    const key = createHash("sha256")
      .update(
        [
          artifact.size,
          artifact.digest,
          artifact.format ?? "",
          // An archive unpacks the same wherever its program is; a single
          // file is written under the name its declaration gives it.
          isArchive(artifact.format) ? "" : artifact.path,
        ].join("\0"),
      )
      .digest("hex")
      .slice(0, 40);
    return join(this.dir, key);
  }

  private program(artifact: BinaryArtifact): string {
    return join(this.folder(artifact), ...artifact.path.split("/"));
  }

  // ── download ──────────────────────────────────────────

  /**
   * Read what `url` answers and answer its size and SHA-256. Each part is
   * handed to `take`, and more than `limit` bytes is refused as soon as it
   * is seen.
   */
  private async read(
    url: string,
    options: {
      signal: AbortSignal | undefined;
      limit?: number;
      take?: (part: Uint8Array) => Promise<unknown>;
    },
  ): Promise<{ size: number; digest: string }> {
    const { signal, limit, take } = options;
    const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    // Called unbound, as the global is.
    const { fetch } = this;
    const response = await fetch(url, {
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (limit !== undefined && size > limit)
          throw new Error(`is larger than the ${limit} bytes declared`);
        hash.update(value);
        await take?.(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { size, digest: hash.digest("hex") };
  }

  /** The artifact from the first provider whose answer is the declared bytes. */
  private async download(
    name: string,
    artifact: BinaryArtifact,
    to: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const failures: string[] = [];
    for (const { url } of artifact.providers) {
      const file = await open(to, "w", 0o600);
      try {
        const got = await this.read(url, {
          signal,
          limit: artifact.size,
          take: (part) => file.writeFile(part),
        });
        if (got.size !== artifact.size)
          throw new Error(
            `is ${got.size} bytes, not the ${artifact.size} declared`,
          );
        if (got.digest !== artifact.digest)
          throw new Error("does not match the declared SHA-256");
        return;
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${new URL(url).host}: ${(error as Error).message}`);
      } finally {
        await file.close();
      }
    }
    throw new BinaryError(
      "download_failed",
      `Could not download ${name}. ${failures.join("; ")}`,
    );
  }

  // ── unpack and check ──────────────────────────────────

  /** The commands that unpack an archive, each tried until one succeeds. */
  private unpackers(
    format: BinaryFormat,
    archive: string,
    tree: string,
  ): Array<[command: string, args: string[]]> {
    // The owner recorded in an archive is not this host's to give.
    const tar = ["-xf", archive, "-C", tree, "--no-same-owner"];
    if (format !== "zip") return [["tar", tar]];
    if (process.platform === "win32") return [[windowsTar(), tar]];
    // GNU tar does not read zip; bsdtar, as on macOS, does.
    return [
      ["unzip", ["-q", archive, "-d", tree]],
      ["tar", tar],
    ];
  }

  private async extract(
    name: string,
    format: BinaryFormat,
    archive: string,
    tree: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const failures: string[] = [];
    for (const [command, args] of this.unpackers(format, archive, tree)) {
      try {
        const result = await this.runner.run(command, args, {
          signal,
          timeoutMs: UNPACK_TIMEOUT_MS,
        });
        if (result.code === 0) return;
        failures.push(
          `${command}: ${failureDetail(result) || `exit ${result.code}`}`,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${command}: ${(error as Error).message}`);
      }
    }
    throw new BinaryError(
      "unpack_failed",
      `Could not unpack ${name}. ${failures.join("; ")}`,
    );
  }

  /** Unpack a verified artifact into `tree` and answer its program's path. */
  private async unpack(
    name: string,
    artifact: BinaryArtifact,
    download: string,
    tree: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const { format } = artifact;
    const program = join(tree, ...artifact.path.split("/"));
    if (isArchive(format)) {
      await this.extract(name, format, download, tree, signal);
    } else {
      await mkdir(dirname(program), { recursive: true });
      if (format === "gz")
        await pipeline(
          createReadStream(download),
          createGunzip(),
          createWriteStream(program),
        );
      else await rename(download, program);
    }
    // A link inside an archive can point anywhere: the program is the
    // file it resolves to, which must be one of the unpacked files.
    const root = await realpath(tree);
    const target = await realpath(program).catch(() => undefined);
    if (!target?.startsWith(`${root}${sep}`) || !(await stat(target)).isFile())
      throw new BinaryError(
        "unpack_failed",
        `${name}: there is no program at ${artifact.path} in what was downloaded`,
      );
    if (process.platform !== "win32") await chmod(target, 0o755);
    return program;
  }

  /**
   * Run the program's own check. It gets the few variables every
   * program codemode starts gets, not the host's environment and what it
   * holds.
   */
  private async check(
    name: string,
    program: string,
    args: string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let failure: string;
    try {
      const result = await this.runner.run(program, args, {
        signal,
        timeoutMs: CHECK_TIMEOUT_MS,
        env: inheritedEnvironment(),
      });
      if (result.code === 0) return;
      failure = failureDetail(result) || `exit ${result.code}`;
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = (error as Error).message;
    }
    throw new BinaryError(
      "check_failed",
      `${name} was not installed: it does not run on this host. ${failure}`,
    );
  }
}

/**
 * The path of a binary a plugin declares, for an action that runs it. A binary
 * that is not there is an error that says what to do about it.
 */
export function pluginBinaryPath(
  manager: BinaryManager,
  plugin: Pick<PluginDef, "name" | "binaries">,
  name: string,
): string {
  const declaration = Object.hasOwn(plugin.binaries ?? {}, name)
    ? plugin.binaries?.[name]
    : undefined;
  if (!declaration)
    throw new BinaryError(
      "not_declared",
      `${plugin.name} declares no binary named "${name}"`,
    );
  const status = manager.status(declaration);
  if (status.path) return status.path;
  throw status.supported
    ? new BinaryError(
        "not_installed",
        `${plugin.name}: the binary "${name}" is not installed. Run: codemode binaries install ${name}`,
      )
    : new BinaryError(
        "unsupported_platform",
        `${plugin.name}: the binary "${name}" has no build for this platform (${status.platform})`,
      );
}

/**
 * The binaries a set of plugins declares, on one manager: what the SDK's
 * `codemode.binaries` and the CLI's `codemode binaries` both are.
 */
export class PluginBinaries {
  constructor(
    private readonly plugins: () => Iterable<
      Pick<PluginDef, "name" | "binaries">
    >,
    private readonly manager: BinaryManager,
  ) {}

  private declared(name?: string) {
    const found = [...this.plugins()].flatMap((plugin) =>
      Object.entries(plugin.binaries ?? {}).flatMap(([binary, declaration]) =>
        name === undefined || binary === name
          ? [{ plugin: plugin.name, name: binary, declaration }]
          : [],
      ),
    );
    if (name !== undefined && !found.length)
      throw new BinaryError(
        "not_declared",
        `No loaded plugin declares a binary named "${name}"`,
      );
    return found;
  }

  private rows(name?: string): PluginBinary[] {
    return this.declared(name).map(({ plugin, name: binary, declaration }) => ({
      plugin,
      name: binary,
      ...this.manager.status(declaration),
    }));
  }

  /** Every declared binary, with its state on this host. */
  list(): PluginBinary[] {
    return this.rows();
  }

  /**
   * Install the binary with this name, or every declared binary, and answer
   * their state. Binaries with no build for this platform are left out of
   * "every".
   */
  async install(
    name?: string,
    options: BinaryCallOptions = {},
  ): Promise<PluginBinary[]> {
    for (const binary of this.declared(name)) {
      if (name === undefined && !binaryArtifact(binary.declaration)) continue;
      await this.manager.install(binary.name, binary.declaration, options);
    }
    return this.rows(name);
  }

  /** Delete the installed binary with this name. Answers whether there was one. */
  async remove(name: string): Promise<boolean> {
    let removed = false;
    for (const binary of this.declared(name))
      removed = (await this.manager.remove(binary.declaration)) || removed;
    return removed;
  }
}
