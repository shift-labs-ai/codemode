#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { actions } from "./commands/actions.js";
import { auth } from "./commands/auth.js";
import {
  connectionAdd,
  connectionList,
  connectionRemove,
} from "./commands/connection.js";
import { exec } from "./commands/exec.js";
import { init } from "./commands/init.js";
import { mcpAdd, mcpList, mcpRefresh, mcpRemove } from "./commands/mcp.js";
import {
  packageInstall,
  packageList,
  packageRemove,
  packageSearch,
  packageTrust,
  packageUpdate,
} from "./commands/packages.js";
import { pluginInstall, pluginList, pluginRemove } from "./commands/plugin.js";

const collect = (value: string, previous: string[]) => [...previous, value];

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

program
  .name("codemode")
  .description(
    "Code mode for agents — turn any API or command into a callable action",
  )
  .version(`codemode ${version}`, "-v, --version")
  .option("--json", "Output as JSON")
  .option("-q, --quiet", "Suppress output")
  .option("--no-color", "Disable color output")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().color === false) {
      process.env.NO_COLOR = "1";
    }
  })
  .addHelpText(
    "after",
    `
Examples:
  $ codemode exec 'return await docker.containers.list()'
  $ codemode exec -f ./scripts/deploy.js
  $ codemode actions
  $ codemode connection add gh --plugin github --set token=ghp_xxx
  $ codemode auth gmail
  $ codemode mcp add sentry --url https://mcp.sentry.dev/mcp

https://github.com/shift-labs-ai/codemode`,
  );

program
  .command("exec <code>")
  .alias("e")
  .description("Execute JavaScript code that calls plugin actions")
  .option("-f, --file", "Treat <code> as a file path")
  .option(
    "-e, --package <source>",
    "Load a package for this run only (repeatable)",
    collect,
    [],
  )
  .addHelpText(
    "after",
    `
The code runs as the body of an async function in a worker thread.
Each loaded plugin is a global: dot-chain into its action and await the call.
The \`actions\` object lists, finds, describes and checks actions.
A bundled plugin is loaded once a connection names it.

Examples:
  $ codemode exec 'return await docker.containers.list()'
  $ codemode exec -f ./scripts/deploy.js
  $ codemode exec 'return actions.find("create issue")'
  $ codemode exec 'return await github.user.listRepos({ username: "torvalds" })'`,
  )
  .action(async (code, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await exec(code, {
      file: opts.file,
      packages: opts.package,
      json: globals.json,
      quiet: globals.quiet,
    });
  });

program
  .command("actions")
  .description("List all available actions and their schemas")
  .option(
    "-c, --connected",
    "Only show actions for plugins with connections and for MCP servers",
  )
  .option(
    "-e, --package <source>",
    "Load a package for this listing only (repeatable)",
    collect,
    [],
  )
  .action(async (opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await actions({
      json: globals.json,
      connected: opts.connected,
      packages: opts.package,
    });
  });

// ── connection ──────────────────────────────────────────

const connCmd = program
  .command("connection")
  .alias("conn")
  .description("Manage connections");

connCmd
  .command("add <name>")
  .description("Add a connection")
  .requiredOption("-p, --plugin <plugin>", "Plugin name")
  .option("-s, --set <key=value...>", "Config values", collect, [])
  .action(async (name, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await connectionAdd(name, {
      plugin: opts.plugin,
      set: opts.set,
      json: globals.json,
    });
  });

connCmd
  .command("remove <name>")
  .description("Remove a connection")
  .action(async (name, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await connectionRemove(name, { json: globals.json });
  });

connCmd
  .command("list")
  .description("List connections")
  .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await connectionList({ json: globals.json });
  });

// ── packages ────────────────────────────────────────────

program
  .command("install <source>")
  .description(
    "Install a plugin package (npm:<name>[@version], git:<host>/<path>[@ref], URL, or path)",
  )
  .option(
    "-l, --local",
    "Record it in the project's .codemode instead of ~/.codemode",
  )
  .option("-y, --yes", "Install without asking")
  .addHelpText(
    "after",
    `
Fetches the package, shows its plugins, their read/write actions and the
hosts their credentials reach, and asks before recording it. Install
scripts never run.

Examples:
  $ codemode install npm:@acme/codemode-orders@1.2.0
  $ codemode install git:github.com/acme/codemode-tools@v1 --local
  $ codemode install ./tools/orders`,
  )
  .action(async (source, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await packageInstall(source, {
      local: opts.local,
      yes: opts.yes,
      json: globals.json,
      quiet: globals.quiet,
    });
  });

program
  .command("remove <source>")
  .alias("uninstall")
  .description("Remove a configured package and its installed files")
  .option("-l, --local", "Remove it from the project's .codemode")
  .action(async (source, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await packageRemove(source, {
      local: opts.local,
      json: globals.json,
      quiet: globals.quiet,
    });
  });

program
  .command("update [source]")
  .description("Update configured packages (exact versions stay pinned)")
  .action(async (source, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await packageUpdate(source, { json: globals.json, quiet: globals.quiet });
  });

program
  .command("list")
  .alias("ls")
  .description("List configured packages")
  .option("--outdated", "Show packages with newer versions available")
  .action(async (opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await packageList({ json: globals.json, outdated: opts.outdated });
  });

program
  .command("search [terms]")
  .description("Search npm for packages with the codemode-plugin keyword")
  .action(async (terms, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await packageSearch(terms ?? "", { json: globals.json });
  });

program
  .command("trust [dir]")
  .description(
    "Allow a project's .codemode plugins, packages and MCP servers to load",
  )
  .option("--revoke", "Stop trusting it")
  .action(async (dir, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await packageTrust(dir, { revoke: opts.revoke, json: globals.json });
  });

// ── mcp ─────────────────────────────────────────────────

const mcpCmd = program
  .command("mcp")
  .description("Manage MCP servers, whose tools load as a plugin's actions");

mcpCmd
  .command("add <name> [command...]")
  .description("Add an MCP server: a command after --, or --url")
  .option("--url <url>", "A server reached over Streamable HTTP")
  .option(
    "--env <KEY=VALUE>",
    "Add to the command's environment (repeatable)",
    collect,
    [],
  )
  .option(
    "--header <KEY=VALUE>",
    "Send with every request to the URL (repeatable)",
    collect,
    [],
  )
  .option(
    "-l, --local",
    "Record it in the project's .codemode instead of ~/.codemode",
  )
  .addHelpText(
    "after",
    `
The server's name is how code calls it, with - written as _. A value may
name a placeholder, \${NAME}, filled from the server's connection, then
from the environment, so no secret is written into the entry.

Examples:
  $ codemode mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
  $ codemode mcp add sentry --url https://mcp.sentry.dev/mcp
  $ codemode mcp add docs --url https://example.com/mcp --header 'Authorization=Bearer \${token}'
  $ codemode connection add docs --plugin docs --set token=...`,
  )
  .action(async (name, command, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await mcpAdd(name, command, {
      url: opts.url,
      env: opts.env,
      header: opts.header,
      local: opts.local,
      json: globals.json,
    });
  });

mcpCmd
  .command("remove <name>")
  .description("Remove an MCP server and its cached tool list")
  .option("-l, --local", "Remove it from the project's .codemode")
  .action(async (name, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await mcpRemove(name, { local: opts.local, json: globals.json });
  });

mcpCmd
  .command("list")
  .alias("ls")
  .description("Connect to every enabled MCP server and show its state")
  .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await mcpList({ json: globals.json });
  });

mcpCmd
  .command("refresh [name]")
  .description("Read tool lists again from the servers")
  .action(async (name, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await mcpRefresh(name, { json: globals.json });
  });

// ── plugin ──────────────────────────────────────────────

const pluginCmd = program.command("plugin").description("Manage plugins");

pluginCmd
  .command("install <source>")
  .description("Install a plugin package (same as `codemode install --yes`)")
  .option("-g, --global", "Install globally")
  .action(async (source, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await pluginInstall(source, { global: opts.global, json: globals.json });
  });

pluginCmd
  .command("remove <source>")
  .description("Remove a package (same as `codemode remove`, project first)")
  .action(async (source, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await pluginRemove(source, { json: globals.json });
  });

pluginCmd
  .command("list")
  .description("List loaded plugins and the package each came from")
  .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await pluginList({ json: globals.json });
  });

// ── auth and init ───────────────────────────────────────

program
  .command("auth <plugin>")
  .description(
    "Run the OAuth login flow for a plugin or an MCP server and save the connection",
  )
  .option("-n, --name <name>", "Connection name (default: plugin name)")
  .option("--client-id <id>", "OAuth client ID (falls back to env or prompt)")
  .option(
    "--client-secret <secret>",
    "OAuth client secret (falls back to env or prompt)",
  )
  .addHelpText(
    "after",
    `
The plugin must declare OAuth config via setOAuth(). The flow
opens your browser to the provider's consent screen, catches the
redirect on a localhost port, exchanges the code for tokens, and
writes a connection into .codemode/config.json.

An MCP server reached over HTTP needs no client ID: its endpoints are
discovered and a client is registered with its authorization server.

Examples:
  $ codemode auth gmail
  $ codemode auth sentry
  $ codemode auth gmail --name gmail-work
  $ codemode auth gmail --client-id $CLIENT --client-secret $SECRET`,
  )
  .action(async (plugin, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await auth(plugin, {
      name: opts.name,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      json: globals.json,
      quiet: globals.quiet,
    });
  });

program
  .command("init")
  .description("Create .codemode/ in current directory")
  .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await init({ json: globals.json, quiet: globals.quiet });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
