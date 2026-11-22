# SDK

The `@shiftlabs/codemode` package embeds codemode in a Node.js or Bun process. It provides the engine, plugin loading, connection storage, credential signing, package management, and MCP servers that the command-line interface uses.

Use the SDK when an application runs code for its own users or agents. The host supplies plugins and connections explicitly, so nothing is read from disk or the environment unless the host asks.

```typescript
import { Codemode, type CodemodePluginAPI } from "@shiftlabs/codemode";
import * as t from "typebox";

function greeter(rl: CodemodePluginAPI) {
  rl.setName("greeter");
  rl.setVersion("1.0.0");
  rl.registerAction("hello", {
    access: "read",
    description: "Greet someone by name.",
    inputSchema: t.Object({ name: t.String() }, { additionalProperties: false }),
    execute: ({ name }) => `Hello, ${name}!`,
  });
}

const codemode = Codemode.create({ plugins: [greeter] });

try {
  const { result, error, logs } = await codemode.execute(
    'return await greeter.hello({ name: "Ada" })',
  );
  console.log(error ?? result, logs);
} finally {
  codemode.dispose();
}
```

This registers one plugin, keeps its connection in memory, and runs the code in a worker thread. `execute()` resolves when the run finishes.

## Instance lifecycle

`Codemode.create()` returns an instance that owns a plugin registry, a connection provider, and one pooled worker thread.

| Option | Purpose |
|---|---|
| `plugins` | Plugin functions or plugin definitions to register |
| `connections` | Initial connections, kept in process memory |
| `connectionProvider` | A host implementation that resolves connections per call. Cannot be combined with `connections` |
| `credentialBroker` | Signs requests in the host for plugins that declare their credential |
| `onAction` | Observes every action call |
| `timeoutMs`, `memoryLimitBytes` | Default limits for each run: 30 seconds and 64 MB |
| `maxRunsPerWorker` | Runs one worker serves before it is replaced. The default is 500 |
| `outputDir` | Where output files are written: a command's whole output, a run's whole result, generated media. The default is the system's temporary directory |
| `outputLimit` | How much a run hands back. The default is 2,000 lines and 50 KB. See [Limit a run's result](#limit-a-runs-result) |
| `maxActionOutputBytes` | How much one action may hold in memory. The default is 8 MiB. See [Limit what an action holds](#limit-what-an-action-holds) |

`addPlugin(plugin, connections?)` registers another plugin. Later runs see it, and a run in progress is not disturbed. `actions()`, `plugins()`, and `connections()` report what the instance holds. `connections()` lists only in-memory connections.

`dispose()` stops the pooled worker, after the run it is in the middle of, and closes the MCP sessions of an instance that `fromProject()` created. Call it when a long-lived instance is no longer needed. An idle worker does not keep the process alive, but an open session to a local MCP server does, until it is closed or has been idle for five minutes.

## Execute code

`execute(code, options)` runs one string of code and returns an `ExecuteResult`:

| Field | Contents |
|---|---|
| `result` | The value the code returned, converted to JSON |
| `error` | The error text, present when the run failed, timed out, or exceeded its memory limit |
| `logs` | Captured console lines, each prefixed with its level |

`execute()` does not reject when the code fails. Check `error`.

Pass `timeoutMs` or `memoryLimitBytes` to override the instance defaults for one run. A `timeoutMs` of `0` disables the timeout.

Pass `context` to deliver a value to every action called during the run:

```typescript
const outcome = await codemode.execute(code, {
  context: { userId: "u_123" },
});
```

Actions read it as `ctx.context`. The code being run cannot see or change it, so a host can use it to carry the identity a run acts for.

Concurrent calls to `execute()` run in separate workers. See [Run Code](usage.md) for what the code can use.

## Limit a run's result

A run hands back at most 2,000 lines and 50 KB, whichever comes first, so that whoever reads the result, usually a model, is not handed more than it can use. Set `outputLimit` to change that, and `outputDir` to choose where the rest is kept:

```typescript
const codemode = Codemode.create({
  plugins,
  outputDir: "/data/workspace/outbox",
  outputLimit: { lines: 500, bytes: 16 * 1024 },
});

const { result, truncated, fullResultPath } = await codemode.execute(code);
```

Either number can be set alone, down to 3 lines and 1,024 bytes, and `outputLimit: false` sets no limit.

The limit applies to what a run returns, not to what happens inside it. Code works with whole values: an action that returns 400 KB of rows gives the code all of them, and only what the code returns is measured.

A result within the limit is returned as it is. A larger one is written whole to a new file in `outputDir` and cut:

| Result | What is returned |
|---|---|
| A string | Its last lines |
| A value that fits once strings in it are cut, such as a command's output beside its exit code | The same value, with those strings cut to their last lines |
| Any other value | Text: the first lines of its JSON |

A value's JSON is measured as `JSON.stringify(value, null, 2)`, and a string inside it is held to the line limit by itself.

Cut text ends with a line that says which lines it shows and names the file, such as `[Showing lines 1883-3120 of 3120 (212.4KB in all). Full output: /data/workspace/outbox/codemode-result-3f9c2a1b7d4e5f60.txt]`.

| Field | Contents |
|---|---|
| `truncated` | `true` when `result` is cut from a larger one |
| `fullResultPath` | The file that holds the whole result: `.json`, or `.txt` for a string |

A run's `error` and `logs` are held to the same limit. Each keeps its last lines and names a file with all of it.

Pass either option to `execute()` to set it for one run. Actions read the directory as `ctx.outputDir`, and the shell runner, the DuckDB package, and the media plugins write their files there. Output files are readable only by the account that runs codemode, and codemode never deletes them: the host that names the directory clears it.

## Limit what an action holds

An action that produces output in parts, such as a command or a query, holds at most 8 MiB of it in memory and hands that to the code that called it. Set `maxActionOutputBytes` to change that:

```typescript
const codemode = Codemode.create({
  plugins,
  maxActionOutputBytes: 64 * 1024 * 1024,
});
```

This limit guards the process, where the output limit serves the reader. They are set apart:

| Setting | Applies to | Default | Past it |
|---|---|---|---|
| `maxActionOutputBytes` | What one action hands to code | 8 MiB | The action keeps the rest in a file and says so in its result |
| `outputLimit` | What a run hands back | 2,000 lines and 50 KB | Codemode cuts the result and names a file with all of it |

The least it can be is 1,024 bytes. Pass it to `execute()` to set it for one run. Actions read it as `ctx.maxOutputBytes`; `runShell`, the shell packages, and the DuckDB package follow it.

## Load plugins

Pass plugin functions directly when the host bundles them. To load the plugins that ship with codemode, use `discoverPlugins()` and name the ones you want:

```typescript
import { discoverPlugins, Codemode } from "@shiftlabs/codemode";

const plugins = await discoverPlugins(null, {
  builtinAllowlist: new Set(["github", "slack"]),
});

const codemode = Codemode.create({
  plugins,
  connections: [{ name: "gh", plugin: "github", config: { token } }],
});
```

`discoverPlugins(configDir, options)` returns plugins from a project's `.codemode` folder when one is given and trusted, from the user's `~/.codemode/plugins/` folder, from configured MCP servers when `mcp` is supplied, from configured packages when `packages` is supplied, and from the bundled set. Bundled plugins outside `builtinAllowlist` are not imported. Pass `userDir` to read a folder other than `~/.codemode`.

Each discovered plugin carries `sourceInfo` with its module path, origin, scope, and owner. Plugins the host constructs itself have none.

## Load a project

`Codemode.fromProject(dir)` builds an instance from the nearest `.codemode` folder at or above `dir`, as the command-line interface does. It returns `null` when there is none.

```typescript
const codemode = await Codemode.fromProject(process.cwd());
```

It registers the project's plugin files, packages, and MCP servers when the project is trusted, the user's plugins, packages, and MCP servers, and the bundled plugins that the project's connections put in use. Connections are read from and written to the project's `config.json`. It never installs a missing package.

| Option | Purpose |
|---|---|
| `trust` | Decides whether the project's plugins, packages, and MCP servers load. The default reads `trust.json` in `userDir` |
| `userDir` | The user's codemode folder. The default is `~/.codemode` |
| `packages` | A `PackageManager` to load packages with, or `false` to load none |
| `mcp` | An `McpManager` to load MCP servers with, or `false` to load none. The caller closes a manager it passes, and registers a server again when its tools change |

See [Supply trust from a host](security.md#supply-trust-from-a-host).

## Supply connections

A `ConnectionProvider` resolves the connection for each action call. Implement one when connections live in the host's own storage or differ per user:

```typescript
import type { ConnectionProvider } from "@shiftlabs/codemode";

const provider: ConnectionProvider = {
  async resolve({ plugin, context }) {
    const { userId } = context as { userId: string };
    const name = `${plugin}:${userId}`;
    return {
      read: async () => ({ name, plugin, config: await store.read(userId, plugin) }),
      update: async (change) => ({
        name,
        plugin,
        config: await store.update(userId, plugin, change),
      }),
    };
  },
};

const codemode = Codemode.create({ plugins, connectionProvider: provider });
```

`resolve()` receives the plugin name, the action, the plugin's connection schema, the plugin's `owner`, and the run's `context`. Throw from it to refuse the call. Codemode does not fall back to environment variables or files.

The returned handle stays bound to one connection. `read()` returns a snapshot. `update()` applies a patch, or runs an updater function against freshly read config while holding ownership of the connection, and returns the committed snapshot. Plugins use it to store renewed tokens, so coordinate it across every writer that shares the storage.

An optional `failed(error)` method on the handle is called once when an action that used the connection throws. Use it to mark a connection whose credential was refused.

Return `owner` on a connection made for a plugin from a package or for an MCP server, whose owner is `mcp:<server>`. Codemode refuses a connection whose owner differs from the plugin's. See [Understand names and connections](packages.md#understand-names-and-connections).

`MemoryConnectionProvider` and `FileConnectionProvider` are the two built-in implementations. Only `FileConnectionProvider` fills missing fields from environment variables.

## Sign requests in the host

By default a plugin signs requests with the secret in its connection. A host that keeps secrets outside the process running plugin code passes `credentialBroker`:

```typescript
const codemode = Codemode.create({
  plugins,
  connectionProvider: provider,
  credentialBroker: ({ plugin, action, context }) => ({
    request: (request) => signer.send({ plugin, action, context, request }),
    probe: () => signer.probe({ plugin, context }),
  }),
});
```

Codemode calls the function once per action call of a plugin that declares its credential and passes the result to the action as `ctx.credentials`. The plugin then sends every request through it, and its connection config holds public settings only.

A broker follows these rules:

- **Authorize, then sign.** The broker is the authority: plugin code chooses the request, so decide from `context` and `action` before signing.
- **Sign with what you loaded.** Take the selection from `plugin.credential(config)` on the plugin definition the host loaded itself: its types, targets, token endpoints, scopes, application and roles. Never take any of it from the plugin's process.
- **Do the signing with the same primitives.** `CredentialRegistry` validates and holds types; `CredentialTransport` signs, renews and stores against a `CredentialBinding` (type, method, a `ConnectionHandle`, identity, application, resource owner, JWT identity, AWS role). Its options are the egress `fetch` (enforce DNS and IP policy there), `timeoutMs` (default 20 s), `maxRequestBytes` (1 MiB), `maxResponseBytes` (8 MiB), and the ceilings a target may raise them to: `maxTargetTimeoutMs` (10 min) and `maxTargetResponseBytes` (256 MiB).
- **Run the consent.** `buildAuthUrl`, `generatePKCE` and `exchangeAuthCode` drive the authorization-code flow for a plugin's `setOAuth` config where `runOAuth`'s local callback server cannot run; `buildOAuth2AuthorizationUrl`, `exchangeOAuth2Code`, `refreshOAuth2Token`, `acquireOAuth2ClientToken`, `acquireOAuth2PasswordToken` and `acquireOAuth2JwtToken` are the protocol primitives under them.

## Observe action calls

`onAction` runs in the host process after each action's `execute` function settles:

```typescript
const codemode = Codemode.create({
  plugins,
  onAction: ({ path, durationMs, error }) => {
    metrics.record(path, durationMs, error === undefined);
  },
});
```

It receives `plugin`, `action`, `path`, `durationMs`, and `error` when the action threw. Calls to unknown actions and calls rejected by input validation never reach plugin code and are not reported. An exception thrown by the observer is ignored.

## Manage packages

`PackageManager` installs, updates, and loads plugin packages with storage, folders, the process runner, and trust supplied by the host. See [Embed the package manager](packages.md#embed-the-package-manager).

## Load MCP servers

`McpManager` loads MCP servers as plugins, with storage, connections, the transport, and trust supplied by the host. See [Embed the MCP manager](mcp.md#embed-the-mcp-manager).

## Understand the limits

The SDK runs plugin code in the host process and calling code in a worker thread of the same process. Neither is isolated from the host. To run untrusted code, isolate the process that embeds codemode. See [Security](security.md).
