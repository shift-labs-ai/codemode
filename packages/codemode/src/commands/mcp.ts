import chalk from "chalk";
import { configPath, findConfigDir, userConfigDir } from "../config/loader.js";
import { isProjectTrusted, setProjectTrusted } from "../config/trust.js";
import { FileConnectionProvider } from "../connections/file.js";
import type { McpScope } from "../mcp/config.js";
import { isMcpServerError } from "../mcp/errors.js";
import {
  McpManager,
  type McpServerInfo,
  type McpServerStatus,
} from "../mcp/manager.js";
import {
  failCommand,
  keyValuePairs,
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
function cliMcpManager(options: { trustProject?: boolean } = {}): McpManager {
  return McpManager.forCodemodeFolders({
    roots: { user: userConfigDir(), project: findConfigDir() ?? undefined },
    trust: (root) => options.trustProject === true || isProjectTrusted(root),
    connections: new FileConnectionProvider(configPath()),
    // What explains a call that then only times out. On stderr, like every
    // other problem a command reports beside its result.
    onEvent: (event) => {
      if (event.type === "fault")
        printWarn(`MCP server "${event.server}": ${event.message}`);
    },
  });
}

/**
 * Run `work` with the CLI's manager, and end its sessions before the
 * command reports or exits, whichever way `work` ends: a stdio server is a
 * child process, and none is left running. Every command gets its manager
 * here.
 */
export async function withCliMcp<T>(
  work: (mcp: McpManager) => Promise<T>,
  options: { trustProject?: boolean } = {},
): Promise<T> {
  const mcp = cliMcpManager(options);
  try {
    return await work(mcp);
  } finally {
    await mcp.close();
  }
}

/**
 * The configured server called `name`, which is its configuration key
 * (`my-tools`) or its name in code (`my_tools`).
 */
export async function configuredServer(
  mcp: McpManager,
  name: string,
): Promise<McpServerInfo | undefined> {
  return (await mcp.list().catch(() => [])).find(
    (server) => server.name === name || server.plugin === name,
  );
}

function scopeOf(options: { local?: boolean }): McpScope {
  return options.local ? "project" : "user";
}

function fail(err: unknown, json?: boolean): never {
  failCommand(err, {
    json,
    code: isMcpServerError(err) ? err.code : undefined,
  });
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
    const env = keyValuePairs(options.env, "--env");
    const headers = keyValuePairs(options.header, "--header");
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
    const added = await withCliMcp(
      async (mcp) => {
        await mcp.add(name, entry, { scope });
        if (scope === "project" && project) setProjectTrusted(project, true);
        // Connect once: the tool list is cached for the runs that follow, and
        // a server that cannot be reached is known now, not at the first call.
        return (await mcp.status(name))[0];
      },
      // Adding a server to a project is the person's decision to trust it.
      { trustProject: scope === "project" },
    );
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
    const removed = await withCliMcp((mcp) => mcp.remove(name, { scope }));
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
  let servers: McpServerStatus[];
  try {
    servers = await withCliMcp((mcp) => mcp.status());
  } catch (err) {
    fail(err, options.json);
  }
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
  try {
    const { refreshed, changed, problems } = await withCliMcp((mcp) =>
      mcp.refresh(name),
    );
    if (options.json)
      printJson({ ok: !problems.length, refreshed, changed, problems });
    else {
      for (const problem of problems) printError(problem.message);
      if (refreshed.length)
        printSuccess(
          changed.length
            ? `Tool lists read again; changed: ${changed.join(", ")}`
            : "Tool lists read again; nothing changed",
        );
      else if (!problems.length) console.log("No enabled MCP servers to read.");
    }
    if (problems.length) process.exitCode = 1;
  } catch (err) {
    fail(err, options.json);
  }
}
