import { join } from "node:path";
import chalk from "chalk";
import { findConfigDir, userConfigDir } from "../config/loader.js";
import { isProjectTrusted, setProjectTrusted } from "../config/trust.js";
import { FileConnectionProvider } from "../connections/file.js";
import type { McpScope } from "../mcp/config.js";
import { isMcpServerError } from "../mcp/errors.js";
import { McpManager, type McpServerStatus } from "../mcp/manager.js";
import {
  printError,
  printJson,
  printSuccess,
  printWarn,
} from "../utils/output.js";

/**
 * The MCP manager the CLI uses: `~/.codemode` for user scope, the nearest
 * project `.codemode` for project scope (trusted through `codemode trust`),
 * and the project's connections for the servers' secrets and sign-ins.
 */
export function cliMcpManager(
  options: { trustProject?: boolean } = {},
): McpManager {
  const project = findConfigDir() ?? undefined;
  return McpManager.forCodemodeFolders({
    roots: { user: userConfigDir(), project },
    trust: (root) => options.trustProject === true || isProjectTrusted(root),
    connections: new FileConnectionProvider(
      join(project ?? join(process.cwd(), ".codemode"), "config.json"),
    ),
  });
}

function scopeOf(options: { local?: boolean }): McpScope {
  return options.local ? "project" : "user";
}

function fail(err: unknown, json?: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json)
    printJson({
      ok: false,
      error: message,
      code: isMcpServerError(err) ? err.code : undefined,
    });
  else printError(message);
  process.exit(1);
}

/** `KEY=VALUE` pairs as an object; the value may itself contain `=`. */
function pairs(values: string[], flag: string): Record<string, string> {
  return Object.fromEntries(
    values.map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0)
        throw new Error(`Invalid ${flag} value: ${pair} (expected KEY=VALUE)`);
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}

export async function mcpAdd(
  name: string,
  command: string[],
  options: {
    url?: string;
    env: string[];
    header: string[];
    local?: boolean;
    json?: boolean;
  },
): Promise<void> {
  const scope = scopeOf(options);
  const project = findConfigDir();
  try {
    if (scope === "project" && !project)
      throw new Error(
        "No .codemode folder here: run `codemode init`, or add the server without --local",
      );
    if (!!options.url === command.length > 0)
      throw new Error(
        "Give either --url <url> or a command after --, for example: codemode mcp add files -- npx -y @modelcontextprotocol/server-filesystem .",
      );
    if (options.url && options.env.length)
      throw new Error("--env applies to a command, not to --url");
    if (!options.url && options.header.length)
      throw new Error("--header applies to --url, not to a command");
    const env = pairs(options.env, "--env");
    const headers = pairs(options.header, "--header");
    const entry: Record<string, unknown> = options.url
      ? {
          url: options.url,
          ...(Object.keys(headers).length ? { headers } : {}),
        }
      : {
          command: command[0],
          ...(command.length > 1 ? { args: command.slice(1) } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        };
    // Adding a server to a project is the person's decision to trust it.
    const mcp = cliMcpManager({ trustProject: scope === "project" });
    await mcp.add(name, entry, { scope });
    if (scope === "project" && project) setProjectTrusted(project, true);
    // Connect once: the tool list is cached for the runs that follow, and
    // a server that cannot be reached is known now, not at the first call.
    const [added] = await mcp.status(name);
    await mcp.close();
    if (options.json) printJson({ ok: true, ...added });
    else {
      printSuccess(
        `Added MCP server ${chalk.bold(name)} (${scope}), in code as ${chalk.cyan(added.plugin)}: ${stateLabel(added)}`,
      );
      if (added.error) printWarn(added.error.split("\n")[0]);
    }
  } catch (err) {
    fail(err, options.json);
  }
}

export async function mcpRemove(
  name: string,
  options: { local?: boolean; json?: boolean },
): Promise<void> {
  const scope = scopeOf(options);
  try {
    const removed = await cliMcpManager({
      trustProject: scope === "project",
    }).remove(name, { scope });
    if (!removed) throw new Error(`No ${scope} MCP server is named ${name}`);
    if (options.json) printJson({ ok: true, removed: name, scope });
    else printSuccess(`Removed MCP server ${chalk.bold(name)} (${scope})`);
  } catch (err) {
    fail(err, options.json);
  }
}

function stateLabel(server: McpServerStatus): string {
  if (server.state === "connected")
    return chalk.green(`connected, ${server.tools ?? 0} tool(s)`);
  if (server.state === "disabled") return chalk.dim("disabled");
  if (server.state === "needs_sign_in") return chalk.yellow("needs sign-in");
  return chalk.red("failed");
}

/** Connects to every enabled server; exit status 1 when one is not connected. */
export async function mcpList(options: { json?: boolean }): Promise<void> {
  const mcp = cliMcpManager();
  let servers: McpServerStatus[];
  try {
    servers = await mcp.status();
  } catch (err) {
    await mcp.close();
    fail(err, options.json);
  }
  await mcp.close();
  if (options.json) printJson(servers);
  else if (!servers.length) console.log("No MCP servers configured.");
  else
    for (const server of servers) {
      console.log(
        `  ${chalk.bold(server.name)} ${stateLabel(server)} ${chalk.dim(`(${server.scope}, ${server.transport}: ${server.target})`)}`,
      );
      if (server.error) console.log(`    ${server.error.split("\n")[0]}`);
    }
  if (
    servers.some(
      (server) => server.state !== "connected" && server.state !== "disabled",
    )
  )
    process.exitCode = 1;
}

export async function mcpRefresh(
  name: string | undefined,
  options: { json?: boolean },
): Promise<void> {
  const mcp = cliMcpManager();
  try {
    const changed = await mcp.refresh(name);
    if (options.json) printJson({ ok: true, changed });
    else
      printSuccess(
        changed.length
          ? `Tool lists read again; changed: ${changed.join(", ")}`
          : "Tool lists read again; nothing changed",
      );
  } catch (err) {
    await mcp.close();
    fail(err, options.json);
  }
  await mcp.close();
}
