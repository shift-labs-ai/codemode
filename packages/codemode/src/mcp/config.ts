import type {
  McpHttpServerConfig,
  McpServerConfigResult,
  McpStdioServerConfig,
} from "@earendil-works/pi-mcp";
import { assertPluginName } from "../plugin/api.js";
import type { McpServerErrorCode } from "./errors.js";

export type McpScope = "user" | "project";

/** How an entry's tools reach a model in pi. Codemode reads `hidden` only. */
type Exposure = "codemode" | "deferred" | "direct" | "hidden";

/** What codemode reads in an entry beside the shape MCP clients share. */
interface CodemodeEntryFields {
  /**
   * The tools to load, by the server's names: a name or a pattern where `*`
   * matches any characters includes, `!pattern` excludes. With no including
   * pattern, every tool not excluded loads.
   */
  tools?: string[];
  /** Pi's field, read so an entry copies over: `hidden` loads no tool. */
  exposure?: Exposure;
  /** Pi's field: per tool name or pattern, `hidden` or not. */
  toolExposure?: Record<string, Exposure>;
}

export type McpServerEntry = (McpStdioServerConfig | McpHttpServerConfig) &
  CodemodeEntryFields;

/** One place a scope's servers are defined: a file, or a host's own record. */
export interface McpSource {
  /** Names the place in messages and in a plugin's `sourceInfo`. */
  source: string;
  /** Entries by server name, as written. */
  servers: Record<string, unknown>;
  /** What a stdio entry's relative `cwd` resolves from. */
  base?: string;
  /** Set when the place could not be read; its servers are then empty. */
  error?: string;
}

/** A configured server, after its scopes and files are merged. */
export interface McpServer {
  /** Its configuration key. */
  name: string;
  /** Its name as a plugin, and so in code: the key with `-` as `_`. */
  plugin: string;
  scope: McpScope;
  source: string;
  base?: string;
  kind: "stdio" | "http";
  enabled: boolean;
  config: McpServerEntry;
}

export interface McpProblem {
  level: "error" | "warning";
  code: McpServerErrorCode;
  message: string;
  server?: string;
}

/** The fields a project entry may change in a server the user defines. */
const OVERRIDABLE = ["enabled", "tools", "exposure", "toolExposure"] as const;

const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The key as a plugin name. Keys that differ only in `-` and `_` are one name. */
export function pluginNameOf(server: string): string {
  return server.replace(/-/g, "_");
}

/** What is wrong with the fields codemode adds, or undefined. */
function codemodeFieldsError(
  entry: Record<string, unknown>,
): string | undefined {
  const { tools, exposure, toolExposure } = entry;
  if (
    tools !== undefined &&
    !(
      Array.isArray(tools) &&
      tools.every((pattern) => typeof pattern === "string" && pattern)
    )
  )
    return "tools must be an array of names or patterns";
  if (exposure !== undefined && !EXPOSURES.includes(exposure as string))
    return `exposure must be one of ${EXPOSURES.join(", ")}`;
  if (
    toolExposure !== undefined &&
    !(
      isRecord(toolExposure) &&
      Object.values(toolExposure).every((value) =>
        EXPOSURES.includes(value as string),
      )
    )
  )
    return `toolExposure must map tool names to one of ${EXPOSURES.join(", ")}`;
  for (const field of ["env", "headers"] as const) {
    const values = entry[field];
    if (!isRecord(values)) continue;
    for (const [key, value] of Object.entries(values))
      if (typeof value === "string" && value.startsWith("!"))
        return `${field}.${key} starts with "!": codemode never runs a command for a value. Use \${NAME} and keep the value in the server's connection or the environment`;
  }
  return undefined;
}

function matches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(name);
}

/** Pi's `toolExposure` rule: an exact name, else the first matching pattern. */
function exposureOf(config: McpServerEntry, tool: string): Exposure {
  const map = config.toolExposure ?? {};
  if (Object.hasOwn(map, tool)) return map[tool];
  for (const [pattern, exposure] of Object.entries(map))
    if (pattern.includes("*") && matches(pattern, tool)) return exposure;
  return config.exposure ?? "codemode";
}

/** Whether an entry loads the server's tool of this name. */
export function loadsTool(config: McpServerEntry, tool: string): boolean {
  if (exposureOf(config, tool) === "hidden") return false;
  const patterns = config.tools ?? [];
  if (
    patterns.some(
      (pattern) => pattern.startsWith("!") && matches(pattern.slice(1), tool),
    )
  )
    return false;
  const including = patterns.filter((pattern) => !pattern.startsWith("!"));
  return (
    !including.length || including.some((pattern) => matches(pattern, tool))
  );
}

/** A hidden server with no tool exposed one by one loads nothing, like a disabled one. */
function enabled(config: McpServerEntry): boolean {
  if (config.enabled === false) return false;
  if (config.exposure !== "hidden") return true;
  return Object.values(config.toolExposure ?? {}).some(
    (exposure) => exposure !== "hidden",
  );
}

/**
 * The servers a set of scopes defines, and what is wrong with the rest.
 * Within a scope, the first place that defines a name is used and a second
 * is reported. A project entry replaces the user's entry of the same name,
 * or, when it has no `command`, `url` or `type`, overrides a few of its
 * fields. Servers whose names differ only in `-` and `_` are one plugin
 * name: the project's, else the first, is kept.
 */
export function resolveServers(
  scopes: Partial<Record<McpScope, McpSource[]>>,
  check: {
    validate(name: string, raw: unknown): McpServerConfigResult;
    isOverride(entry: Record<string, unknown>): boolean;
  },
): { servers: McpServer[]; problems: McpProblem[] } {
  const problems: McpProblem[] = [];
  const invalid = (message: string, server?: string) =>
    problems.push({ level: "error", code: "invalid_config", message, server });

  /** A scope's entries by name, each with the place that defines it. */
  const entriesOf = (scope: McpScope) => {
    const entries = new Map<string, { raw: unknown; from: McpSource }>();
    for (const from of scopes[scope] ?? []) {
      if (from.error !== undefined) {
        invalid(`MCP servers in ${from.source} were not read: ${from.error}`);
        continue;
      }
      for (const [name, raw] of Object.entries(from.servers)) {
        const first = entries.get(name);
        if (first)
          problems.push({
            level: "warning",
            code: "name_conflict",
            server: name,
            message: `MCP server "${name}" is defined in ${first.from.source} and in ${from.source}; the first is used.`,
          });
        else entries.set(name, { raw, from });
      }
    }
    return entries;
  };

  const user = entriesOf("user");
  const project = entriesOf("project");
  const servers: McpServer[] = [];
  const add = (
    name: string,
    raw: unknown,
    scope: McpScope,
    from: McpSource,
  ): void => {
    const result = check.validate(name, raw);
    if (result.kind === "invalid")
      return void invalid(`${result.error} (${from.source})`, name);
    const fieldsError = codemodeFieldsError(result.config);
    if (fieldsError)
      return void invalid(
        `server "${name}": ${fieldsError} (${from.source})`,
        name,
      );
    const plugin = pluginNameOf(name);
    try {
      assertPluginName(plugin);
    } catch {
      return void invalid(
        `MCP server "${name}" (${from.source}) cannot be named in code: "${plugin}" is not an identifier, or is reserved by JavaScript or the code runtime. Rename the server.`,
        name,
      );
    }
    const taken = servers.find((server) => server.plugin === plugin);
    if (taken)
      return void problems.push({
        level: "error",
        code: "name_conflict",
        server: name,
        message: `MCP server "${name}" (${from.source}) was not loaded: its name in code, "${plugin}", is the one "${taken.name}" (${taken.source}) has. Rename one.`,
      });
    const config = result.config as McpServerEntry;
    servers.push({
      name,
      plugin,
      scope,
      source: from.source,
      base: from.base,
      kind: result.kind,
      enabled: enabled(config),
      config,
    });
  };

  for (const [name, { raw, from }] of project) {
    if (!isRecord(raw) || !check.isOverride(raw)) {
      add(name, raw, "project", from);
      continue;
    }
    const base = user.get(name);
    if (!base || !isRecord(base.raw)) {
      invalid(
        `MCP server "${name}" (${from.source}) has no "command" or "url", and no user-level server of that name to override.`,
        name,
      );
      continue;
    }
    const unknown = Object.keys(raw).filter(
      (key) => !(OVERRIDABLE as readonly string[]).includes(key),
    );
    if (unknown.length) {
      invalid(
        `MCP server "${name}" (${from.source}) overrides a user-level server and may set only ${OVERRIDABLE.join(", ")}; not ${unknown.join(", ")}.`,
        name,
      );
      continue;
    }
    add(name, { ...base.raw, ...raw }, "user", base.from);
  }
  for (const [name, { raw, from }] of user) {
    if (project.has(name)) continue;
    add(name, raw, "user", from);
  }
  return { servers, problems };
}
