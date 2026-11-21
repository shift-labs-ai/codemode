# Plugins

A plugin is a TypeScript or JavaScript module that registers actions under one name. Write a plugin to give code access to an API or a host capability that the [bundled plugins](bundled-plugins.md) do not cover.

Plugins run inside the codemode process with its permissions. To share a plugin with other people or projects, publish it as a [package](packages.md).

## Create a plugin

Put the module in a `plugins` folder. Codemode loads `.codemode/plugins/` from a trusted project and `~/.codemode/plugins/` for every project:

```text
.codemode/plugins/weather.ts
```

The module default-exports a function that receives the plugin API and registers actions:

```typescript
import type { CodemodePluginAPI } from "@shiftlabs/codemode";
import * as t from "typebox";

export default function weather(rl: CodemodePluginAPI) {
  rl.setName("weather");
  rl.setVersion("1.0.0");

  rl.registerAction("forecast.get", {
    access: "read",
    description: "Get the current temperature at a coordinate.",
    inputSchema: t.Object(
      {
        latitude: t.Number({ minimum: -90, maximum: 90 }),
        longitude: t.Number({ minimum: -180, maximum: 180 }),
      },
      { additionalProperties: false },
    ),
    async execute({ latitude, longitude }) {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(latitude));
      url.searchParams.set("longitude", String(longitude));
      url.searchParams.set("current", "temperature_2m");
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`weather: request failed (HTTP ${response.status})`);
      return response.json();
    },
  });
}
```

Codemode loads the file directly, with no build step. The imports of `@shiftlabs/codemode` and `typebox` resolve to the copies codemode itself uses, so the plugin folder needs no `node_modules`.

Call the action:

```bash
codemode exec 'return await weather.forecast.get({ latitude: 52.52, longitude: 13.41 })'
```

`codemode init` trusts the project it creates. In a project created another way, run `codemode trust` before its plugins load. See [Project trust](security.md#understand-project-trust).

## Define actions

`registerAction(name, definition)` adds one action. The name is relative to the plugin and can contain dots, so `forecast.get` in the plugin `weather` is called as `weather.forecast.get()`. Do not repeat the plugin name in it.

| Field | Purpose |
|---|---|
| `access` | `"read"` for actions that only retrieve data. `"write"` for anything that creates, changes, deletes, sends, executes, or may otherwise affect a system |
| `description` | One sentence that code sees in `actions.find()` and `actions.describe()` |
| `inputSchema` | A TypeBox object schema. Codemode validates input against it before `execute` runs |
| `outputSchema` | A JSON Schema of the result's structured part. Optional; `actions.describe()` returns it |
| `hints` | `destructive`, `idempotent`, and `openWorld`: what the action says about its effects beyond `access`. Optional |
| `execute(input, ctx)` | The implementation. Its return value is the action's result |

Set `additionalProperties: false` on the input schema so a misspelled field is rejected instead of ignored.

Name each input as the provider's own reference names that parameter, in camelCase. Linear's `issue(id:)` becomes `linear.issue.get({ id })`, and AgentMail's `inbox_id` becomes `inboxId`. An agent that knows the API then already knows the action, and a value the provider returns can be passed back under the same name.

Return plain data. Results are converted to JSON before they reach the caller. Throw an `Error` to fail the call; the caller receives its message.

Return a file's path instead of large or binary content. `writeOutputFile(prefix, extension, data, ctx.outputDir)` from `@shiftlabs/codemode` writes a new file that only the user can read and answers its path.

`execute` receives a context as its second argument:

| Property | Contents |
|---|---|
| `ctx.connection` | The resolved connection, with its `config` |
| `ctx.context` | A value the host passed to `execute()` for this run, invisible to the calling code |
| `ctx.credentials` | The host's request signer, when the host keeps credentials outside this process |
| `ctx.signal` | An `AbortSignal` that fires when the run that made the call ends. Pass it to work that should stop with the run |
| `ctx.outputDir` | Where the host keeps output files, when it names a place. Write large or binary output there with `writeOutputFile()` and return the path |
| `ctx.log` | `info`, `warn`, and `error`, prefixed with the plugin name |
| `ctx.updateConnection(patch)` | Persists a change to the connection's config through the host |

`setDescription(text)` says what the plugin's actions are for as a group. Code reads it with `actions.plugin(name)`.

## Declare a connection

A plugin that needs configuration declares a connection schema. Each field can name the environment variable that supplies it:

```typescript
rl.setConnectionSchema(
  t.Object({
    apiKey: t.String({ env: "ORDERS_API_KEY", description: "Orders API key" }),
    region: t.Optional(t.Union([t.Literal("us"), t.Literal("eu")])),
  }),
);
```

The values arrive in `ctx.connection.config`. See [Connections](connections.md) for how a user supplies them.

## Authenticate requests

A plugin that calls an authenticated API declares its credential and sends requests through codemode's helpers. It does not read the secret or build an `Authorization` header:

```typescript
import { credentialJson, pathSegment, type CodemodePluginAPI, staticCredential } from "@shiftlabs/codemode";
import * as t from "typebox";

const credential = staticCredential({
  id: "orders",
  auth: { kind: "bearer" },
  local: { secret: "apiKey" },
  targets: {
    api: { baseUrl: "https://api.orders.example/v1/", methods: ["GET"] },
  },
});

export default function orders(rl: CodemodePluginAPI) {
  rl.setName("orders");
  rl.setVersion("1.0.0");
  rl.setCredential(credential);
  rl.setConnectionSchema(t.Object({ apiKey: t.String({ env: "ORDERS_API_KEY" }) }));

  rl.registerAction("list", {
    access: "read",
    description: "List an organization's orders, newest first.",
    inputSchema: t.Object(
      { orgId: t.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    execute: ({ orgId }, ctx) =>
      credentialJson(ctx, credential, "orders", {
        target: "api",
        path: `orgs/${pathSegment(orgId)}/orders`,
      }),
  });
}
```

The declaration states what the secret is, how it is placed, and the HTTPS targets that may receive it. Codemode refuses any request outside those targets. A host that keeps credentials elsewhere signs the same requests without the plugin changing.

[Credentials](credentials.md) covers every kind of declaration, including OAuth, AWS, and cookie sessions. [Credentials Reference](credentials-reference.md) lists the request and error helpers.

## Run a shell command

A plugin that runs commands uses `runShell` from `@shiftlabs/codemode/utils/cli`. It starts one new process per call and ends that process, and everything it started, when the call times out or is aborted:

```typescript
import { runShell } from "@shiftlabs/codemode/utils/cli";

const result = await runShell(
  { program: "/bin/bash", args: ["-c"] },
  "git status --short",
  { cwd: repo, timeoutMs: 30_000, signal: ctx.signal, outputDir: ctx.outputDir },
);
// { output: " M README.md\n", exitCode: 0, truncated: false, wallTimeMs: 12 }
```

Pass `ctx.signal` so that a command ends with the run that started it, and `ctx.outputDir` so that output past the limit is kept where the host keeps its output files.

| Outcome | Result |
|---|---|
| The script exits, with any exit code | Resolves with `output`, `exitCode`, `truncated`, and `wallTimeMs` |
| A signal ends the shell | Resolves with `exitCode` 128 plus the signal's number |
| The program cannot start, or `cwd` does not exist | Rejects with a `ShellError` whose `code` is `spawn_failed` |
| The script outlives `timeoutMs` | Rejects with `code` `timed_out`. `output` holds what it wrote |
| `signal` aborts | Rejects with `code` `aborted` |

`output` is stdout and stderr together. They are two pipes, so a line of one may land before an earlier line of the other. Output past `maxOutputBytes`, 1 MiB by default, keeps its start and end around a marker, and the whole of it is written to a file named by `fullOutputPath` that only your account can read. The file is in `outputDir`, or in the system's temporary directory.

The command inherits the environment of the codemode process, with `env` added to it. It runs in a process group of its own, and codemode ends that group when its own process exits or is interrupted. Check a failure with `isShellError()`.

## Understand how plugins load

Codemode looks for plugins in this order:

1. A trusted project's `.codemode/plugins/` folder, then the paths in its `.codemode/plugins.json`
2. `~/.codemode/plugins/`
3. Configured [MCP servers](mcp.md), each as a plugin of its tools
4. Installed [packages](packages.md)
5. The plugins bundled with codemode

The first plugin with a name keeps it, and codemode reports later duplicates on stderr. A plugin that does not call `setName` is named after its module file, which for a folder is `index`, so always set the name.

A plugin's name is a variable in the code that calls it. It must be a JavaScript identifier, and it cannot be a reserved word or one of the runtime's own names: `actions`, `console`, `fetch`, `require`, and `FerroSearch`. Codemode refuses a plugin with any other name when it loads.

A `plugins` folder accepts these layouts:

| Entry | Loaded module |
|---|---|
| `orders.ts` or `orders.js` | The file |
| `orders/` with a `package.json` that sets `main` | The `main` module |
| `orders/` with a `package.json` that sets `codemode.plugins` | Every listed module, under the [package rules](packages.md#create-a-package) |
| `orders/` otherwise | The first of `src/index.ts`, `src/index.js`, `index.ts`, and `index.js` |

Codemode skips folders whose names start with `_` or `.`, and files ending in `.d.ts` or `.test.ts`.

`plugins.json` lists modules that live elsewhere. Relative paths resolve from the `.codemode` folder:

```json
{
  "plugins": [{ "path": "../tools/orders.ts" }]
}
```

A bundled plugin's name is protected, because the name selects the connection and so the credentials. A local plugin named like a bundled plugin is not loaded unless `config.json` lists that name:

```json
{
  "replaceableBuiltins": ["github"]
}
```

An MCP server takes a bundled plugin's name only while no connection puts that plugin in use. See [Understand names](mcp.md#understand-names).

A broken plugin does not stop the others from loading. Codemode reports the module's path and the reason on stderr and continues.

## Understand where plugin code runs

Plugin modules and their `execute` functions run in the host process, with full access to Node.js and to the dependencies the host process can resolve. Calling code runs in a separate worker thread and reaches a plugin only through its actions.

Loading a plugin runs its module. Keep work out of the module's top level and out of the registration function, which runs on every start.

A module can also default-export a plain object with `name`, `version`, and `actions`. The function form is preferred because it gives the module the typed plugin API.

## Debug a plugin

List what loaded and where it came from, then inspect one action from inside a run:

```bash
codemode plugin list
codemode exec 'return actions.describe("weather.forecast.get")'
codemode exec 'return actions.check("weather.forecast.get", { latitude: 52.52 })'
```

`codemode actions --json` prints every loaded action with its schema. Load failures appear on stderr with the module path. Common causes are a name that cannot be a variable, a missing entry point, a malformed `package.json` or `plugins.json`, an untrusted project, and a name that another plugin already holds.

## Share a plugin

Publish plugins as a package to install them with `codemode install`. A package names its plugin modules in `package.json` and carries its own dependencies. See [Packages](packages.md).

To add a plugin to the bundled set, see [`packages/codemode-plugins`](../packages/codemode-plugins/README.md).
