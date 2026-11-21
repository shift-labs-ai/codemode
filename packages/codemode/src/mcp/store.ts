import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readConnectionFile, updateLockedFile } from "../config/store.js";
import { isRecord, type McpScope, type McpSource } from "./config.js";
import { McpServerError } from "./errors.js";

/**
 * Where MCP servers are configured. The manager reads and changes entries
 * only through this; hosts keep them wherever they keep their own state.
 */
export interface McpStore {
  /** Every place the scope's servers are defined, the one that wins a duplicate name first. */
  read(scope: McpScope): Promise<McpSource[]>;
  /**
   * Record `entry` under `name`: in the place that defines the server, else
   * in the scope's first. `undefined` removes the server from every place
   * of the scope. Answers whether the scope defined it before.
   */
  write(
    scope: McpScope,
    name: string,
    entry: Record<string, unknown> | undefined,
  ): Promise<boolean>;
}

const SERVERS_KEY = "mcpServers";

/** A file's `mcpServers`, as an object of entries. */
function serversIn(data: Record<string, unknown>): Record<string, unknown> {
  const servers = data[SERVERS_KEY];
  if (servers === undefined) return {};
  if (!isRecord(servers))
    throw new Error(`"${SERVERS_KEY}" must be an object of servers by name`);
  return servers;
}

/** An `mcp.json` file: a JSON object, empty when the file is missing. */
function readMcpFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("unreadable file");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("malformed JSON");
  }
  if (!isRecord(data)) throw new Error("expected a JSON object");
  return data;
}

/**
 * Entries kept the way the CLI keeps them, in each codemode folder: under
 * `"mcpServers"` in `config.json`, and in an `mcp.json` file of the shape
 * MCP clients share. A new server goes to `config.json`; every write takes
 * the file's lock, so one to `config.json` never races a connection update.
 */
export class FileMcpStore implements McpStore {
  private readonly folders: Partial<Record<McpScope, string>>;

  constructor(folders: Partial<Record<McpScope, string>>) {
    this.folders = {
      user: folders.user ? resolve(folders.user) : undefined,
      project: folders.project ? resolve(folders.project) : undefined,
    };
  }

  /** The scope's files, each with how its JSON is read. */
  private files(scope: McpScope): Array<{
    path: string;
    read: (path: string) => Record<string, unknown>;
  }> {
    const folder = this.folders[scope];
    if (!folder) return [];
    return [
      { path: join(folder, "config.json"), read: readConnectionFile },
      { path: join(folder, "mcp.json"), read: readMcpFile },
    ];
  }

  async read(scope: McpScope): Promise<McpSource[]> {
    return this.files(scope).map(({ path, read }) => {
      // A relative cwd resolves from the directory holding the codemode folder.
      const place = { source: path, base: dirname(dirname(path)) };
      try {
        return { ...place, servers: structuredClone(serversIn(read(path))) };
      } catch (error) {
        return { ...place, servers: {}, error: (error as Error).message };
      }
    });
  }

  async write(
    scope: McpScope,
    name: string,
    entry: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    const files = this.files(scope);
    if (!files.length)
      throw new McpServerError(
        "not_found",
        `No ${scope} folder to record MCP servers in`,
      );
    const defines = (file: (typeof files)[number]) => {
      if (!existsSync(file.path)) return false;
      try {
        return Object.hasOwn(serversIn(file.read(file.path)), name);
      } catch (error) {
        throw new McpServerError(
          "invalid_config",
          `MCP servers in ${file.path} were not read: ${(error as Error).message}`,
        );
      }
    };
    const defining = files.filter(defines);
    const targets = entry === undefined ? defining : [defining[0] ?? files[0]];
    for (const { path, read } of targets)
      await updateLockedFile(path, read, (data) => {
        const servers = { ...serversIn(data) };
        if (entry === undefined) delete servers[name];
        else servers[name] = structuredClone(entry);
        if (Object.keys(servers).length) data[SERVERS_KEY] = servers;
        else delete data[SERVERS_KEY];
        return { result: undefined, write: true };
      });
    return defining.length > 0;
  }
}

/** Entries held in memory: for tests and hosts that persist elsewhere. */
export class MemoryMcpStore implements McpStore {
  private readonly scopes: Record<McpScope, Record<string, unknown>>;

  constructor(
    initial: Partial<Record<McpScope, Record<string, unknown>>> = {},
    /** What a stdio entry's relative `cwd` resolves from. */
    private readonly base?: string,
  ) {
    this.scopes = {
      user: structuredClone(initial.user ?? {}),
      project: structuredClone(initial.project ?? {}),
    };
  }

  async read(scope: McpScope): Promise<McpSource[]> {
    return [
      {
        source: `${scope} MCP servers`,
        servers: structuredClone(this.scopes[scope]),
        base: this.base,
      },
    ];
  }

  async write(
    scope: McpScope,
    name: string,
    entry: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    const existed = Object.hasOwn(this.scopes[scope], name);
    if (entry === undefined) delete this.scopes[scope][name];
    else this.scopes[scope][name] = structuredClone(entry);
    return existed;
  }
}
