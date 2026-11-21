import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "./config.js";
import { McpServerError } from "./errors.js";

/** An entry with its placeholders filled: what a transport is built from. */
export type McpResolvedServer =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      /** Absolute, or undefined to start the server where the host runs. */
      cwd?: string;
      /** The server's whole environment: nothing else is inherited. */
      env: Record<string, string>;
    }
  | { kind: "http"; url: string; headers: Record<string, string> };

/** What a stdio server inherits from the host's environment when a host names nothing else. */
export const INHERITED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TERM",
  // Windows: where programs, profiles and temporary files are found.
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "TEMP",
  "TMP",
];

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, as in a shell. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (
    value.startsWith("~/") ||
    (process.platform === "win32" && value.startsWith("~\\"))
  )
    return join(homedir(), value.slice(2));
  return value;
}

/**
 * A value with `${NAME}` and `$NAME` replaced by what `lookup` holds for
 * the name, and `$$` by one `$`: the syntax MCP clients share. A name
 * `lookup` does not hold is an error, never an empty string: an empty
 * bearer reaches the server as a different, confusing failure.
 */
function fillPlaceholders(
  value: string,
  lookup: (name: string) => string | undefined,
  where: string,
): string {
  return value.replace(
    /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      if (name === undefined) return "$";
      const found = lookup(name);
      if (found === undefined || found === "")
        throw new McpServerError(
          "invalid_config",
          `${where} needs "${name}", which is not set. Add it to the server's connection or the environment.`,
        );
      return found;
    },
  );
}

/** What a placeholder names: the connection's value of that name, else the variable. */
function lookupIn(options: {
  connection: Readonly<Record<string, unknown>>;
  variable: (name: string) => string | undefined;
}): (name: string) => string | undefined {
  return (name) => {
    const held = options.connection[name];
    if (typeof held === "string") return held;
    if (typeof held === "number" || typeof held === "boolean")
      return String(held);
    return options.variable(name);
  };
}

/**
 * Fill a server's entry for one identity. A placeholder in `env`,
 * `headers` or `oauth.clientSecret` reads the connection's config first,
 * then `variable`. A stdio server gets `inherited` and its entry's `env`,
 * and nothing else of the host's environment.
 */
export function resolveServer(
  server: McpServer,
  options: {
    connection: Readonly<Record<string, unknown>>;
    variable: (name: string) => string | undefined;
    inherited: Readonly<Record<string, string | undefined>>;
  },
): McpResolvedServer {
  const lookup = lookupIn(options);
  const fill = (values: Record<string, string> | undefined, field: string) =>
    Object.fromEntries(
      Object.entries(values ?? {}).map(([key, value]) => [
        key,
        fillPlaceholders(
          value,
          lookup,
          `MCP server "${server.name}": ${field}.${key}`,
        ),
      ]),
    );
  const { config } = server;
  if ("url" in config)
    return {
      kind: "http",
      url: config.url,
      headers: fill(config.headers, "headers"),
    };
  const inherited = Object.fromEntries(
    Object.entries(options.inherited).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    kind: "stdio",
    command: expandHome(config.command),
    args: (config.args ?? []).map(expandHome),
    ...(config.cwd === undefined && server.base === undefined
      ? {}
      : { cwd: resolve(server.base ?? "", expandHome(config.cwd ?? ".")) }),
    env: { ...inherited, ...fill(config.env, "env") },
  };
}

/** An entry's `oauth.clientSecret`, filled like its headers. */
export function resolveClientSecret(
  server: McpServer,
  options: {
    connection: Readonly<Record<string, unknown>>;
    variable: (name: string) => string | undefined;
  },
): string | undefined {
  const secret =
    "url" in server.config ? server.config.oauth?.clientSecret : undefined;
  if (secret === undefined) return undefined;
  return fillPlaceholders(
    secret,
    lookupIn(options),
    `MCP server "${server.name}": oauth.clientSecret`,
  );
}
