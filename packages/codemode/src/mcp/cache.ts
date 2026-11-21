import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tool } from "@earendil-works/pi-mcp";
import { replaceFile } from "../config/store.js";
import { isRecord, type McpScope } from "./config.js";
import type { McpServerErrorCode } from "./errors.js";

/** What a server said about itself the last time it was connected to. */
export interface McpServerSnapshot {
  /** Identifies the entry the snapshot was taken through; another entry's is not used. */
  key: string;
  tools: Tool[];
  /** Whether the server offers resources. */
  resources: boolean;
  instructions?: string;
  version?: string;
  /** Milliseconds since epoch. */
  savedAt: number;
  /**
   * Set when the last connect failed: why. Such a snapshot offers nothing;
   * it keeps a server that is down from being tried on every load.
   */
  failure?: { code: McpServerErrorCode; message: string };
}

/**
 * Where server snapshots are kept between runs, so loading a server's
 * actions does not need a connection to it.
 */
export interface McpToolCache {
  read(scope: McpScope, server: string): Promise<McpServerSnapshot | undefined>;
  write(
    scope: McpScope,
    server: string,
    snapshot: McpServerSnapshot,
  ): Promise<void>;
  remove(scope: McpScope, server: string): Promise<void>;
}

function isSnapshot(value: unknown): value is McpServerSnapshot {
  if (!isRecord(value)) return false;
  const snapshot = value as Partial<McpServerSnapshot>;
  return (
    typeof snapshot.key === "string" &&
    typeof snapshot.savedAt === "number" &&
    typeof snapshot.resources === "boolean" &&
    (snapshot.failure === undefined ||
      (isRecord(snapshot.failure) &&
        typeof snapshot.failure.code === "string" &&
        typeof snapshot.failure.message === "string")) &&
    Array.isArray(snapshot.tools) &&
    snapshot.tools.every(
      (tool: unknown) =>
        isRecord(tool) &&
        typeof tool.name === "string" &&
        isRecord(tool.inputSchema),
    )
  );
}

/** One JSON file per server under `<folder>/mcp/`. An unreadable file is a miss. */
export class FileMcpToolCache implements McpToolCache {
  private readonly folders: Partial<Record<McpScope, string>>;

  constructor(folders: Partial<Record<McpScope, string>>) {
    this.folders = {
      user: folders.user ? resolve(folders.user) : undefined,
      project: folders.project ? resolve(folders.project) : undefined,
    };
  }

  /** Server names are letters, digits, `_` and `-`, so a name is a file name. */
  private path(scope: McpScope, server: string): string | undefined {
    const folder = this.folders[scope];
    return folder && /^[A-Za-z0-9_-]+$/.test(server)
      ? join(folder, "mcp", `${server}.json`)
      : undefined;
  }

  async read(
    scope: McpScope,
    server: string,
  ): Promise<McpServerSnapshot | undefined> {
    const path = this.path(scope, server);
    if (!path) return undefined;
    try {
      const snapshot: unknown = JSON.parse(readFileSync(path, "utf8"));
      return isSnapshot(snapshot) ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  async write(
    scope: McpScope,
    server: string,
    snapshot: McpServerSnapshot,
  ): Promise<void> {
    const path = this.path(scope, server);
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    replaceFile(path, `${JSON.stringify(snapshot)}\n`);
  }

  async remove(scope: McpScope, server: string): Promise<void> {
    const path = this.path(scope, server);
    if (path) rmSync(path, { force: true });
  }
}

/** Snapshots held in memory: for tests and hosts that persist elsewhere. */
export class MemoryMcpToolCache implements McpToolCache {
  private readonly snapshots = new Map<string, McpServerSnapshot>();

  async read(
    scope: McpScope,
    server: string,
  ): Promise<McpServerSnapshot | undefined> {
    return structuredClone(this.snapshots.get(`${scope}:${server}`));
  }

  async write(
    scope: McpScope,
    server: string,
    snapshot: McpServerSnapshot,
  ): Promise<void> {
    this.snapshots.set(`${scope}:${server}`, structuredClone(snapshot));
  }

  async remove(scope: McpScope, server: string): Promise<void> {
    this.snapshots.delete(`${scope}:${server}`);
  }
}
