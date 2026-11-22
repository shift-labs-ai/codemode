# Command Line

This page documents the `codemode` command, its subcommands, and their options.

```text
codemode [options] <command> [arguments]
```

Run `codemode --help` or `codemode <command> --help` for the same information in the terminal.

## Global options

| Option | Behavior |
|---|---|
| `--json` | Print one JSON value instead of formatted text |
| `-q`, `--quiet` | Suppress progress and informational output |
| `--no-color` | Disable colored output |
| `-v`, `--version` | Print the version and exit |

Codemode reads the nearest `.codemode` folder at or above the working directory. See [Configuration](configuration.md).

## Run code

```sh
codemode exec 'return await github.issue.get({ owner: "nodejs", repo: "node", issueNumber: 1 })'
codemode exec -f ./scripts/triage.js
codemode actions --connected
```

See [Run Code](usage.md) for the calling conventions and the runtime.

- `exec <code>`, alias `e`<br>
  Runs JavaScript and prints the returned value. Logs go to stderr, and `--quiet` hides them. A failed run exits with status 1. With `--json`, prints `{ result, logs }` or `{ error, logs }`, with `truncated` and `fullResultPath` when the result passed the [output limit](configuration.md#settings).
- `exec --no-limit`<br>
  Prints the whole result and logs, however large. Use it to pipe a result to another program.
- `exec -f`, `--file`<br>
  Treats `<code>` as the path of a file to run.
- `exec -e`, `--package <source>`<br>
  Loads a package for this run without recording it. Repeat it for several packages. A relative path resolves from the working directory.
- `actions`<br>
  Lists every loadable action with its access label, inputs, and description. With `--json`, includes each input schema.
- `actions -c`, `--connected`<br>
  Lists only the actions of plugins that have a connection, and of configured MCP servers.
- `actions -e`, `--package <source>`<br>
  Includes a package's actions for this listing only.

`exec` loads a bundled plugin only when a connection names it. `actions` loads every bundled plugin.

Both load every enabled [MCP server](mcp.md) as a plugin. A server whose tool list is not cached is connected to once.

## Connections

```sh
codemode connection add gh --plugin github --set token=$GITHUB_TOKEN
codemode auth gmail
```

See [Connections](connections.md) for environment variables, OAuth setup, and storage.

- `connection add <name> -p <plugin>`<br>
  Adds a connection, or replaces the one with that name. `-p`, `--plugin` is required. `conn` is an alias of `connection`.
- `connection add -s`, `--set <key=value>`<br>
  Sets one config value. Repeat it for several values.
- `connection list`<br>
  Lists connections. With `--json`, includes field names with redacted values.
- `connection remove <name>`<br>
  Removes a connection.
- `auth <plugin>`<br>
  Runs the plugin's OAuth login in the browser and saves the tokens as a connection.
- `auth -n`, `--name <name>`<br>
  Names the connection. The default is the plugin name.
- `auth --client-id <id>`, `--client-secret <secret>`<br>
  Supply the OAuth client. Without them, codemode reads the plugin's environment variables and then prompts.

<a id="package-commands"></a>

## Packages

```sh
codemode install npm:@example/codemode-orders@1.2.0
codemode list --outdated
codemode update
```

See [Packages](packages.md) for sources, versions, and the package format.

- `install <source>`<br>
  Fetches a package, shows its plugins, action counts, and credential targets, and records it after confirmation. Install scripts do not run.
- `install -l`, `--local`<br>
  Records the package in the project's `.codemode` folder instead of `~/.codemode`, and trusts the project.
- `install -y`, `--yes`<br>
  Installs without asking. Required when there is no terminal.
- `remove <source>`, alias `uninstall`<br>
  Removes a package's entry and its installed files. Add `-l`, `--local` to remove it from the project.
- `update [source]`<br>
  Updates one package or all of them. Exact versions, tags, and commits stay where they are. A package that cannot be updated is reported, the others are still updated, and the command exits with status 1.
- `list`, alias `ls`<br>
  Lists configured packages. Add `--outdated` to show the ones with newer versions.
- `search [terms]`<br>
  Searches npm for packages with the `codemode-plugin` keyword.

A source is `npm:<name>[@version]`, `git:<host>/<path>[@ref]`, a git URL, or a local path.

## MCP servers

```sh
codemode mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
codemode mcp add sentry --url https://mcp.sentry.dev/mcp
codemode auth sentry
```

See [MCP Servers](mcp.md) for entries, secrets, and sign-in.

- `mcp add <name> -- <command> [args]`<br>
  Adds a server that runs as a local program, connects to it once, and reports its state.
- `mcp add <name> --url <url>`<br>
  Adds a server reached over Streamable HTTP.
- `mcp add --env <KEY=VALUE>`<br>
  Adds a variable to the command's environment. Repeat it for several.
- `mcp add --header <KEY=VALUE>`<br>
  Sends a header with every request to the URL. Repeat it for several.
- `mcp add -l`, `--local`<br>
  Records the server in the project's `.codemode/config.json` and trusts the project. The default is `~/.codemode/config.json`.
- `mcp list`, alias `mcp ls`<br>
  Connects to every enabled server and prints its state, the number of tools its entry loads, and its error. Exits with status 1 when an enabled server is not connected.
- `mcp refresh [name]`<br>
  Reads tool lists again from every enabled server, or from one. A server that cannot be read is reported, the others are still read, and the command exits with status 1. With `--json`, prints `{ ok, refreshed, changed, problems }`.
- `mcp remove <name>`<br>
  Removes a server and its cached tool list. Add `-l`, `--local` to remove it from the project.
- `auth <name>`<br>
  Signs in to an HTTP server that uses OAuth and saves the result in its connection. The name is the server's, as configured or as written in code.

## Plugins

```sh
codemode plugin list
```

See [Plugins](plugins.md) for how plugins load.

- `plugin list`<br>
  Lists loaded plugins with their versions, action counts, and the folder, package, or MCP configuration each came from. It starts no MCP server, so a server whose tool list is not cached shows no actions.
- `plugin install <source>`<br>
  Installs a package into the project without asking. Add `-g`, `--global` to install into `~/.codemode`.
- `plugin remove <source>`<br>
  Removes a package from the project, or from `~/.codemode` when the project does not have it.

## Projects

```sh
codemode init
codemode trust
```

- `init`<br>
  Creates `.codemode/config.json` and `.codemode/plugins/` in the working directory and trusts the new project.
- `trust [dir]`<br>
  Allows the plugins, packages, and MCP servers of a project's `.codemode` folder to load. The default is the nearest one. Your own `~/.codemode` folder needs no trust and is refused.
- `trust --revoke`<br>
  Withdraws that trust.

See [Project trust](security.md#understand-project-trust).

## Exit status

Commands exit with status 0 on success and 1 on failure. With `--json`, a failed package or MCP command prints `{ ok: false, error, code }`.
