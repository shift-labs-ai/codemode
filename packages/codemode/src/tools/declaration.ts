import { createRequire } from "node:module";

/**
 * How an artifact is packed, as a DotSlash file names it. An artifact with
 * no format is the program itself.
 */
export const TOOL_FORMATS = [
  "gz",
  "tar",
  "tar.gz",
  "tar.bz2",
  "tar.xz",
  "tar.zst",
  "zip",
] as const;
export type ToolFormat = (typeof TOOL_FORMATS)[number];

/**
 * One platform's build of a tool: the fields of a DotSlash file's platform
 * entry that codemode reads.
 */
export interface ToolArtifact {
  /** The artifact's size in bytes. */
  size: number;
  hash: "sha256";
  /** The artifact's SHA-256, in lowercase hex. */
  digest: string;
  format?: ToolFormat;
  /** The program: its place inside an archive, or the name a single file gets. */
  path: string;
  /** Where the artifact is downloaded from, tried in order. */
  providers: Array<{ url: string }>;
}

/** A program a plugin runs, as its package declares it under `codemode.tools`. */
export interface ToolDeclaration {
  /**
   * Arguments the program is run with once it is unpacked. It must exit
   * with 0, or it is not installed: the program itself says whether it
   * runs on this host.
   */
  check?: string[];
  /** A build per platform, keyed as `toolPlatform()` names them. */
  platforms: Record<string, ToolArtifact>;
}

/** A plugin's tools, by the name `ctx.tool` takes. */
export type ToolDeclarations = Record<string, ToolDeclaration>;

const SYSTEMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};
const PROCESSORS: Record<string, string> = {
  arm64: "aarch64",
  x64: "x86_64",
};

/** This host's platform as a DotSlash file keys it, such as `macos-aarch64`. */
export function toolPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${SYSTEMS[platform] ?? platform}-${PROCESSORS[arch] ?? arch}`;
}

/** Whether a format unpacks to a folder of files rather than to one file. */
export function isArchive(format: ToolFormat | undefined): boolean {
  return format !== undefined && format !== "gz";
}

/** What a declaration says of this host, before anything is downloaded. */
export interface ToolSummary {
  /** This host's platform, as declarations key it. */
  platform: string;
  /** Whether the tool declares a build for it. */
  supported: boolean;
  /** The hosts that build is downloaded from. */
  hosts: string[];
  /** The download's size in bytes. */
  size?: number;
}

export function summarizeTool(tool: ToolDeclaration): ToolSummary {
  const platform = toolPlatform();
  const artifact = Object.hasOwn(tool.platforms, platform)
    ? tool.platforms[platform]
    : undefined;
  return {
    platform,
    supported: artifact !== undefined,
    hosts: [
      ...new Set(
        (artifact?.providers ?? []).map(({ url }) => new URL(url).host),
      ),
    ],
    ...(artifact ? { size: artifact.size } : {}),
  };
}

const TOOL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A path that stays inside the folder it is joined to. */
function isInnerPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    !/[\\\0]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function httpsSources(providers: unknown): Array<{ url: string }> {
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((provider) => {
    // A DotSlash file may name other ways to fetch, such as a GitHub CLI
    // download. Those are passed over.
    if (!isRecord(provider) || (provider.type ?? "http") !== "http") return [];
    try {
      const url = new URL(String(provider.url));
      return url.protocol === "https:" ? [{ url: url.href }] : [];
    } catch {
      return [];
    }
  });
}

function parseArtifact(entry: unknown, fail: (m: string) => never, at: string) {
  if (!isRecord(entry)) fail(`${at} must be an object`);
  const { size, hash, digest, format, path } = entry;
  if (!(Number.isSafeInteger(size) && (size as number) >= 0))
    fail(`${at}.size must be the artifact's size in bytes`);
  if (hash !== "sha256") fail(`${at}.hash must be "sha256"`);
  if (!(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)))
    fail(`${at}.digest must be a SHA-256 in lowercase hex`);
  if (
    format !== undefined &&
    !(TOOL_FORMATS as readonly unknown[]).includes(format)
  )
    fail(`${at}.format must be one of ${TOOL_FORMATS.join(", ")}`);
  if (!isInnerPath(path))
    fail(`${at}.path must be a relative path inside the artifact`);
  const providers = httpsSources(entry.providers);
  if (!providers.length)
    fail(`${at}.providers must hold at least one { "url": "https://…" }`);
  const artifact: ToolArtifact = {
    size: size as number,
    hash,
    digest,
    ...(format === undefined ? {} : { format: format as ToolFormat }),
    path,
    providers,
  };
  return artifact;
}

/**
 * Read a `codemode.tools` block. `where` names the file in errors, each of
 * which names the field that is wrong.
 */
export function parseTools(value: unknown, where: string): ToolDeclarations {
  const fail = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  if (!isRecord(value))
    fail("codemode.tools must be an object of tools by name");
  const tools: ToolDeclarations = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const at = `codemode.tools.${name}`;
    if (!TOOL_NAME.test(name))
      fail(
        `${at} is not a usable name: letters, digits, ".", "_" and "-", starting with a letter or digit`,
      );
    if (!isRecord(raw)) fail(`${at} must be an object`);
    const { check, platforms } = raw as Record<string, unknown>;
    if (
      check !== undefined &&
      !(Array.isArray(check) && check.every((arg) => typeof arg === "string"))
    )
      fail(`${at}.check must be an array of arguments`);
    if (!isRecord(platforms) || !Object.keys(platforms).length)
      fail(`${at}.platforms must name at least one platform`);
    tools[name] = {
      ...(check === undefined ? {} : { check: check as string[] }),
      platforms: Object.fromEntries(
        Object.entries(platforms as Record<string, unknown>).map(
          ([platform, entry]) => [
            platform,
            parseArtifact(entry, fail, `${at}.platforms.${platform}`),
          ],
        ),
      ),
    };
  }
  return tools;
}

/**
 * The tools declared in the `package.json` one directory above a module's
 * own, so a packaged plugin declares them once, as data. Pass
 * `import.meta.url`, and hand the result to `setTools`.
 */
export function packageTools(moduleUrl: string): ToolDeclarations {
  const require = createRequire(moduleUrl);
  const path = require.resolve("../package.json");
  const pkg = require(path) as { codemode?: { tools?: unknown } };
  return parseTools(pkg.codemode?.tools ?? {}, path);
}
