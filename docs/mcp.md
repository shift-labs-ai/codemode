# MCP Servers

Codemode loads a Model Context Protocol server as a plugin and each of its tools as an action. Code finds and calls a server's tools the way it calls any other action, through the same discovery, input checks, and connections.

Use an MCP server when a service publishes one and codemode bundles no plugin for it, or when you already run the server for another client. Codemode is an MCP client only: it does not serve its own actions over MCP.

## Add a server

Add a server that runs as a local program by giving its command after `--`:

```bash
codemode mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
```

Add a server reached over Streamable HTTP by giving its URL:

```bash
codemode mcp add sentry --url https://mcp.sentry.dev/mcp
```

Codemode records the server, connects to it once, and reports its state and tool count. The server is stored in `~/.codemode/config.json`. Add `--local` or `-l` to store it in the project's `.codemode/config.json` instead, which also trusts the project.

| Task | Command |
|---|---|
| Add a server | `codemode mcp add <name> -- <command> [args]` or `codemode mcp add <name> --url <url>` |
| Connect to every server and show its state | `codemode mcp list` |
| Read tool lists again | `codemode mcp refresh [name]` |
| Remove a server and its cached tool list | `codemode mcp remove <name>` |
| Sign in to a server that uses OAuth | `codemode auth <name>` |

See [Command Line](cli.md#mcp-servers) for every option.

## Call a server's tools

A server is a global in the code, under its name with `-` written as `_`. A tool is called by its name with every character outside `A-Z`, `a-z`, `0-9`, and `_` written as `_`:

```bash
codemode exec 'return await sentry.search_issues({ query: "is:unresolved" })'
```

A call returns the tool's whole result, as MCP defines it:

```js
const found = await sentry.search_issues({ query: "is:unresolved" });
// { content: [{ type: "text", text: "..." }], structuredContent: { issues: [...] } }
return found.structuredContent?.issues ?? found.content[0].text;
```

Results are not shortened, and image and audio content stays base64 in `content`. Reduce a large result in the code before returning it.

Discovery works as it does for every plugin. `actions.plugin("sentry")` returns the server's description and its action paths. `actions.describe()` adds three fields for a tool: `hints`, `outputSchema`, and `sourceName`, the server's own name for the tool when the action name differs.

| Tool property | Action property |
|---|---|
| `description`, else `title` | `description` |
| `inputSchema` | The input schema. Codemode validates a call against it before the server is called |
| `annotations.readOnlyHint: true` | `access: "read"`. Every other tool is `"write"` |
| `destructiveHint`, `idempotentHint`, `openWorldHint` | `hints.destructive`, `hints.idempotent`, `hints.openWorld` |
| `outputSchema` | `outputSchema` |

## Handle failures

A tool that reports its own failure rejects the call. The error's message is the tool's text, up to 1,000 characters, and code can catch it:

```js
try {
  await tracker.delete_issue({ id: "7" });
} catch (error) {
  return `not deleted: ${error.message}`;
}
```

MCP delivers such a failure inside a successful response, with `isError` set. Codemode turns it into a rejection so that a call that resolves has worked, as for every other action. Structured content in a failed result is not available to the code.

| Situation | Outcome |
|---|---|
| The tool reports failure | The call rejects with the tool's text |
| The input does not match the tool's schema | The call rejects before the server is called |
| The server answers a protocol error | The call rejects with that error |
| The connection drops | The call rejects, naming the server and, for a local server, what it last printed to stderr |
| The request passes its timeout | The request is cancelled on the server and the call rejects, naming the server and the limit |
| The run ends first | Every tool call it still waits on is cancelled on the server |
| The server asks for sign-in | The call rejects and names the command to run |

Codemode never repeats a tool call that may have run. It retries a call once only when the server reports that it no longer knows the session, because the server then did not run the request.

## Configure servers

Servers are entries of an `mcpServers` object, in the shape that Claude, Cursor, Codex, and pi share, so an entry copies over unchanged:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${token}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

Codemode reads that object from two files in each codemode folder:

| File | Scope |
|---|---|
| `~/.codemode/config.json` and `~/.codemode/mcp.json` | Every project |
| `.codemode/config.json` and `.codemode/mcp.json` | One project, after [project trust](security.md#understand-project-trust) |

`mcp.json` holds only the `mcpServers` object. Use it to share entries with another MCP client or to commit a project's servers without its connections.

| Field | Applies to | Meaning |
|---|---|---|
| `command`, `args` | Local program | One executable and its arguments, never a shell string. A leading `~` is the home directory |
| `env` | Local program | Added to the server's environment |
| `cwd` | Local program | The working directory. A relative path resolves from the directory that holds the codemode folder |
| `url` | HTTP | A Streamable HTTP endpoint. The legacy HTTP+SSE transport is refused |
| `headers` | HTTP | Sent with every request |
| `oauth` | HTTP | A pre-registered client. See [Sign in with OAuth](#sign-in-with-oauth) |
| `timeout` | Both | Seconds per request. The default is 60, and each progress notification restarts it |
| `enabled` | Both | `false` keeps the entry without loading it |
| `description` | Both | One sentence about the server. Without it, the server's own instructions are used |
| `tools` | Both | The tools to load. See [Select tools](#select-tools) |

These rules decide which entry is used:

- A project entry replaces the user-level entry of the same name.
- A project entry with no `command`, `url`, or `type` overrides only `enabled`, `tools`, `exposure`, and `toolExposure` of the user-level entry and keeps the rest.
- A name defined in both files of one folder is reported, and the `config.json` entry is used.
- An invalid entry is reported and skipped. The other servers still load.

Pi's `exposure` and `toolExposure` fields are read so that an entry copies over: `hidden` loads no tool, and the other values change nothing.

## Select tools

`tools` narrows what loads from a server, by the server's own tool names. A name or a pattern includes, where `*` matches any characters, and `!` excludes:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "tools": ["get_*", "search_*", "!get_secret_scanning_alert"]
    }
  }
}
```

With no including pattern, every tool that is not excluded loads.

## Supply secrets

Keep a secret out of the entry by naming a placeholder there and storing the value in the server's connection:

```bash
codemode mcp add docs --url https://example.com/mcp --header 'Authorization=Bearer ${token}'
codemode connection add docs --plugin docs --set token=$DOCS_TOKEN
```

`${NAME}` and `$NAME` in an `env` or `headers` value are filled from the server's connection, then from the environment. `$$` is a literal `$`. A placeholder that nothing fills is an error that names it, and the server is not started.

A value that starts with `!` is refused. Codemode never runs a command to produce a value.

A server that needs no secret needs no connection.

## Sign in with OAuth

An HTTP server whose entry sends no `Authorization` header is signed in to with OAuth:

```bash
codemode auth sentry
```

Codemode discovers the server's authorization server, registers a client named `codemode` with it, opens the consent page, and saves the result in the server's connection. It uses the connection the server already has, and keeps the values in it, or adds one named after the server. It renews the token when it expires or is refused, and asks for `codemode auth` again when the grant can no longer be renewed.

For a server that does not register clients, name a client you registered:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.com/mcp",
      "oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

| `oauth` field | Meaning |
|---|---|
| `clientId`, `clientSecret` | A pre-registered client. Without `clientId`, codemode registers one |
| `callbackPort`, `callbackUrl` | The loopback redirect the client is registered with. The default is `http://127.0.0.1:47823/callback` |
| `scope` | Scopes to request, separated by spaces. The default is what the server asks for |
| `clientName` | The name sent when registering. The default is `codemode` |
| `clientRegistration` | `auto`, `dcr`, or `cimd`: how codemode identifies itself when the entry names no client. The default is `auto` |
| `authServerMetadataUrl` | An authorization server metadata document to use instead of discovery |

A server and its authorization server are reached over HTTPS, or over HTTP when they run on this machine: `localhost`, `127.0.0.1`, or `[::1]`.

The command line registers a client with each authorization server. A host that publishes Client ID Metadata Documents signs in as its document instead:

| `clientRegistration` | Client |
|---|---|
| `auto` | The host's document where the authorization server takes one and the documents list the redirect, else a registered client |
| `dcr` | A registered client |
| `cimd` | The host's document. Sign-in fails where the authorization server takes none, and the entry is refused when the host has no documents |

Signing out is removing the connection: `codemode connection remove <name>`.

## Understand names

A server's name is a variable in the code that calls it and selects its connection.

- A name may contain letters, digits, `_`, and `-`. Two names that differ only in `-` and `_` are one name in code, and codemode loads the first.
- A name must be a JavaScript identifier once `-` is `_`, and cannot be a reserved word or one of the runtime's own names.
- Tools of one server whose names become the same action name each get an eight-character suffix.

A server may take the name of a bundled plugin that is not in use. Codemode decides by the project's connections:

| The name is also | Result |
|---|---|
| A bundled plugin that no connection names | The server takes the name, and the bundled plugin is not loaded |
| A bundled plugin with a connection | The server is not loaded. Rename it, or remove that connection |
| A plugin file in a `plugins` folder | The server is not loaded |
| A packaged plugin | The server keeps the name, and the package's plugin is not loaded |

A connection made for a server records `mcp:<name>` as its `owner`. It does not put a bundled plugin of the same name in use, and neither can use the other's connection.

## Understand how servers connect

Codemode keeps each server's tool list in the `mcp` folder beside the configuration that defines the server. A run builds the server's actions from that list and connects only when the code calls one of them, so a command that never touches a server does not start it.

- A server with no cached list is connected to once when plugins load, with a limit of 10 seconds.
- A server that cannot be reached is reported, loads with no actions, and is left alone for one minute before codemode tries again. `codemode mcp list` always tries.
- A server that asks for sign-in or lacks a value is tried again on every run, so a fix takes effect at once.
- An edited `command`, `args`, `env`, `cwd`, `url`, or `headers` discards the cached list.
- A server that announces a changed tool list has its list read again. The next run sees the new tools.
- A server that sends what is not JSON-RPC, such as a log line on stdout, is reported as a warning on stderr.
- A local server gets a short list of environment variables, such as `PATH` and `HOME`, and its entry's `env`. It does not inherit the rest of the environment.
- When a command ends, codemode closes each local server's input and then terminates its process group, so a server started through `npx` or `uvx` ends too.

## Use resources

A server that offers resources gets three more actions:

| Action | Result |
|---|---|
| `<server>.resources.list({ cursor? })` | One page of `resources`, with `nextCursor` when there are more |
| `<server>.resources.templates({ cursor? })` | One page of `resourceTemplates` |
| `<server>.resources.read({ uri })` | The resource's `contents` |

A resource link in a tool's result is read with `resources.read` of the same server. Prompts, sampling, elicitation, and tasks are not supported.

## Embed the MCP manager

`McpManager` loads servers as plugins and holds the connections to them. The command-line interface is one consumer. A host supplies its own storage, connections, transport, and trust, and the manager never prompts, prints, exits, or reads a folder it was not given.

```typescript
import { Codemode, McpManager, MemoryMcpStore } from "@shiftlabs/codemode";

const mcp = new McpManager({
  store: new MemoryMcpStore({
    user: { docs: { url: "https://example.com/mcp" } },
  }),
  connections,
});

const { plugins, problems } = await mcp.load();
const codemode = Codemode.create({ plugins, connectionProvider: connections });

await codemode.execute('return await docs.search({ query: "billing" })');
await mcp.close();
```

`McpManager.forCodemodeFolders({ roots, trust })` builds a manager over codemode folders as the command line keeps them. `Codemode.fromProject()` creates one by default and closes it in `dispose()`.

| Method | Result |
|---|---|
| `load({ connect?, reservedNames?, context? })` | `{ plugins, problems }`: one plugin per enabled server. `connect: false` never connects, and a server with no cached list then loads with no actions |
| `list({ context? })` | Every configured server, without connecting |
| `status(name?)` | Connects and reports each server's state, the number of tools its entry loads, and its error |
| `refresh(name?)` | Reads tool lists again. `{ refreshed, changed, problems }`: the servers read, those whose tools changed, and one problem per server that could not be read |
| `add(name, entry, { scope? })` | Records a server. A name the scope already defines is refused |
| `remove(name, { scope? })` | Removes a server, its cached list, and its sessions |
| `oauth(name, { redirectUri })` | The server's endpoints as an OAuth2 definition and the client to sign in as |
| `onToolsChanged(listener)` | Calls the listener with a server's name when its tools change |
| `close()` | Ends every session. The manager stays usable |

Failures the manager raises are `McpServerError` values with a `code`, such as `connect_failed`, `reconnect_required`, `tool_failed`, `timed_out`, and `closed`. Check them with `isMcpServerError()`. An error a server answers a request with is thrown as pi-mcp's `McpError`.

| Option | Default | Purpose |
|---|---|---|
| `store` | Required | Where entries are kept: `FileMcpStore`, `MemoryMcpStore`, or the host's own `McpStore` |
| `cache` | Process memory | Where tool lists are kept: `FileMcpToolCache`, or the host's own `McpToolCache` |
| `connections` | None | Resolves a server's connection when the manager connects outside an action call |
| `trust` | Refuse | Whether the project scope's servers may be read and started |
| `createTransport` | pi-mcp's transports | Builds the transport to a server: start local servers in a sandbox, or refuse them |
| `environment` | A short list from the process | What a local server inherits beside its entry's `env` |
| `variable` | The process environment | What a placeholder names when the connection does not hold it |
| `fetch` | The global `fetch` | Sends the requests to HTTP servers, discovery, and the token endpoint |
| `identity` | The connection's name | Tells two people apart when a host resolves one connection name to both. With it, each identity has its own cached tool list |
| `clientMetadataDocuments` | None | The host's Client ID Metadata Documents: `baseUrl` and `listsRedirectUrl(url)`, laid out as pi's are |
| `signInOverHttp` | `loopback` | `never` refuses sign-in to a server on this machine over HTTP, for a host that does not run on the person's own machine |
| `signInHint` | `codemode auth <server>` | How the host tells a person to sign in |
| `idleMs`, `maxSessions` | 5 minutes, 64 | When an unused session is closed |
| `connectTimeoutMs`, `retryFailedAfterMs` | 10 seconds, 1 minute | How long the manager waits for a server to connect, and how long `load()` leaves an unreachable one alone |
| `client` | `codemode` and its version | How codemode names itself to servers |
| `onEvent` | None | Receives session states, changed tool lists, server log messages, stderr, progress, and faults that no call rejects with, such as a message from the server that is not JSON-RPC |

An action call uses the connection the engine resolved for it, and the manager keeps one session per server and identity. Two calls share a session only when the server, the identity, and every value the entry was filled with are the same.

A host that passes `identity` gets one cached tool list per identity. `load({ context })` resolves the server's connection for that context, reads that identity's list, and connects when it has none. A host's own `McpToolCache` receives the identity as the last argument of `read` and `write`. Without `identity`, every connection of a server shares one list and `load()` resolves no connection.

With `clientMetadataDocuments`, the client's identifier is `<baseUrl>/client.json`. For an authorization server whose responses carry no `iss`, it is `<baseUrl>/<id>/client.json` with the redirect `<callback>/<id>`, where `<id>` is derived from the server's URL as pi and Codex derive theirs, so one set of documents serves all three.

A host that runs its own consent flow calls `oauth()`, signs in with `buildOAuth2AuthorizationUrl()` and `exchangeOAuth2Code()` or with `runOAuth()`, and stores `mcpOAuthConnection(setup, tokens)` in the server's connection. Codemode's credential transport renews the grant from there, under the connection's update ownership.

The [credential broker](sdk.md#sign-requests-in-the-host) does not carry MCP: it sends one buffered request, and an MCP server answers with a stream. A host that keeps credentials away from plugin code runs the manager where the credentials are.

## Understand the limits

- A local server is a program that runs with the permissions of the codemode process. Codemode does not sandbox it.
- An HTTP server receives whatever the code sends it, and the headers its entry names.
- An entry can name any environment variable as a placeholder. Trusting a project lets its servers receive the variables their entries name.
- A tool's `access` label and hints are the server's own claims. Treat the tools of a server you do not know as writes.
- A tool's description, a server's instructions, and every result are text from the server. They reach the agent through discovery and can try to steer it.
- The MCP client needs Node.js 22.19 or later. On an older Node.js, codemode reports the servers as a problem and loads everything else.
- On the command line, a cached tool list is shared by every connection of a server. A server that offers different tools to different people shows each of them the list last read.
- A server reached over HTTP on another machine cannot be signed in to: its token would cross the network in the clear.

See [Security](security.md).
