import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { addConnection, loadConfig } from "../config/loader.js";
import { connectionFor } from "../connections/types.js";
import { OAUTH_CALLBACK_URI, oauthCallback, runOAuth } from "../core/oauth.js";
import { mcpOAuthConnection } from "../mcp/auth.js";
import type { McpManager } from "../mcp/manager.js";
import { mcpOwner } from "../mcp/plugin.js";
import { loadAllPlugins } from "../plugin/loader.js";
import { registry } from "../plugin/registry.js";
import { connectionFields } from "../plugin/schema.js";
import type { ConnectionConfig } from "../plugin/types.js";
import {
  printError,
  printJson,
  printSuccess,
  printWarn,
} from "../utils/output.js";
import { configuredServer, withCliMcp } from "./mcp.js";
import { cliPackageManager } from "./packages.js";

interface AuthOptions {
  name?: string;
  clientId?: string;
  clientSecret?: string;
  json?: boolean;
  quiet?: boolean;
}

export function auth(plugin: string, options: AuthOptions): Promise<void> {
  return withCliMcp((mcp) => authWith(mcp, plugin, options));
}

async function authWith(
  mcp: McpManager,
  plugin: string,
  options: AuthOptions,
): Promise<void> {
  await loadAllPlugins({
    builtinAllowlist: new Set([plugin]),
    packages: cliPackageManager({ quiet: true, onMissing: "skip" }),
    mcp,
    mcpLoad: { connect: false },
  });
  const server = await configuredServer(mcp, plugin);
  if (
    server &&
    registry.getPlugin(server.plugin)?.sourceInfo?.owner ===
      mcpOwner(server.name)
  )
    return authMcp(mcp, server, options);
  const def = registry.getPlugin(plugin);
  if (!def) {
    printError(`Plugin "${plugin}" not found. Run \`codemode plugin list\`.`);
    process.exit(1);
  }
  if (!def.oauth) {
    printError(`Plugin "${plugin}" does not declare OAuth config.`);
    process.exit(1);
  }

  // Client credentials: CLI flag > env > plugin default > interactive prompt.
  // Environment names come from the plugin's connection schema.
  const connectionSchema = connectionFields(def.connectionConfigSchema);
  const envIdVar = connectionSchema.clientId?.env;
  const envSecretVar = connectionSchema.clientSecret?.env;
  const publicClient = def.oauth.publicClient === true;

  const resolvedClientId =
    options.clientId ??
    (envIdVar ? process.env[envIdVar] : undefined) ??
    def.oauth.defaultClientId;
  const resolvedClientSecret = publicClient
    ? undefined
    : (options.clientSecret ??
      (envSecretVar ? process.env[envSecretVar] : undefined));
  if (publicClient && options.clientSecret !== undefined) {
    printError(`Plugin "${plugin}" uses a public OAuth client; no secret.`);
    process.exit(1);
  }

  // If we're about to prompt and the plugin published setup help,
  // print it once so the user knows what to paste. Suppressed
  // under --json and --quiet.
  const willPrompt =
    !resolvedClientId || (!publicClient && !resolvedClientSecret);
  if (
    willPrompt &&
    def.oauth.setupHelp &&
    def.oauth.setupHelp.length > 0 &&
    !options.json &&
    !options.quiet
  ) {
    const redirectUri = oauthCallback(def.oauth).uri;
    console.log();
    console.log(chalk.bold(`Setting up ${plugin} OAuth`));
    console.log();
    for (const line of def.oauth.setupHelp) {
      console.log(
        chalk.dim("  ") +
          line.replace(/\{\{redirectUri\}\}/g, chalk.cyan(redirectUri)),
      );
    }
    console.log();
  }

  const clientId =
    resolvedClientId ?? (await prompt(`${plugin} OAuth client ID: `));
  const clientSecret = publicClient
    ? undefined
    : (resolvedClientSecret ??
      (await prompt(`${plugin} OAuth client secret: `)));

  if (!clientId || (!publicClient && !clientSecret)) {
    printError(
      publicClient
        ? "A client ID is required."
        : "Both client ID and client secret are required.",
    );
    process.exit(1);
  }

  const connectionName = options.name ?? plugin;

  if (!options.quiet && !options.json) {
    console.log(`\nOpening browser to authorize ${chalk.bold(plugin)}\u2026`);
  }

  try {
    const tokens = await runOAuth(def.oauth, {
      clientId,
      clientSecret,
      onAuthUrl: (url) => {
        if (!options.quiet && !options.json) {
          console.log(
            chalk.dim(`If it doesn't open automatically, visit:\n  ${url}\n`),
          );
        }
      },
    });

    await addConnection(
      connectionName,
      plugin,
      {
        clientId,
        clientSecret,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.expiresAt,
      },
      { owner: def.sourceInfo?.owner },
    );

    if (options.json) {
      printJson({ ok: true, name: connectionName, plugin });
    } else {
      printSuccess(
        `Connection ${chalk.bold(connectionName)} saved (plugin: ${plugin})`,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(msg);
    process.exit(1);
  }
}

/**
 * The connection an MCP server acts through, of those stored: the one the
 * connection provider resolves for it, when that one was made for it.
 */
export function serverConnection<T extends ConnectionConfig>(
  connections: T[],
  server: { name: string; plugin: string },
): T | undefined {
  const owner = mcpOwner(server.name);
  const found = connectionFor(connections, { plugin: server.plugin, owner });
  return found?.owner === owner ? found : undefined;
}

/**
 * Sign in to an MCP server: discover its endpoints, register a client
 * unless its entry names one, run the same browser consent every OAuth
 * plugin uses, and keep the result in the server's connection beside
 * whatever that connection already holds.
 */
async function authMcp(
  mcp: McpManager,
  server: { name: string; plugin: string },
  options: AuthOptions,
): Promise<void> {
  const say = !options.quiet && !options.json;
  const owner = mcpOwner(server.name);
  const stored = () => serverConnection(loadConfig().connections, server);
  // The connection the server already uses takes the sign-in, whatever it
  // is named: a second one for the same server would never be resolved.
  const connectionName = options.name ?? stored()?.name ?? server.plugin;
  try {
    const setup = await mcp.oauth(server.name, {
      redirectUri: OAUTH_CALLBACK_URI,
    });
    if (say)
      console.log(
        `\nOpening browser to sign in to ${chalk.bold(server.name)}\u2026`,
      );
    const tokens = await runOAuth(
      {
        protocol: setup.definition,
        scopes: setup.scopes,
        redirectUri: setup.redirectUri,
        publicClient: setup.application.clientSecret === undefined,
      },
      {
        clientId: setup.application.clientId,
        clientSecret: setup.application.clientSecret,
        issuer: { value: setup.issuer, required: setup.issuerRequired },
        onAuthUrl: (url) => {
          if (say)
            console.log(
              chalk.dim(`If it doesn't open automatically, visit:\n  ${url}\n`),
            );
        },
      },
    );
    // Read again: the consent took a while, and the values are kept.
    const current = stored();
    const existing = current?.name === connectionName ? current : undefined;
    await addConnection(
      connectionName,
      server.plugin,
      { ...existing?.config, ...mcpOAuthConnection(setup, tokens) },
      { owner },
    );
    // Connect with the new sign-in, so the tool list is cached for the
    // runs that follow. The sign-in is saved whether or not this works.
    const unread = await mcp.refresh(server.name).then(
      ({ problems }) => problems.map((problem) => problem.message),
      (error) => [(error as Error).message],
    );
    if (say) for (const message of unread) printWarn(message);
    if (options.json)
      printJson({ ok: true, name: connectionName, plugin: server.plugin });
    else
      printSuccess(
        `Signed in to ${chalk.bold(server.name)}; connection ${chalk.bold(connectionName)} saved`,
      );
  } catch (err: unknown) {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(q);
    return answer.trim();
  } finally {
    rl.close();
  }
}
