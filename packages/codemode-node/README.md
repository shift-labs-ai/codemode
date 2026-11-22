# codemode-node

A [codemode](../../README.md) package with one plugin, `node`, that gives code the host's files, paths, system facts, hashing, and HTTP as actions.

Install it where code should reach the machine through actions that are named, labelled `read` or `write`, and reported to the host. It is not a sandbox: an action runs with the permissions of the codemode process.

## Install

Install the package. It needs no connection:

```bash
codemode install npm:@shiftlabs/codemode-node
```

It needs a codemode newer than 0.46.0. Through 0.46.0, `node` was a bundled plugin.

## Use files

`node.fs` reads and changes files on the host:

```js
const text = await node.fs.readFile({ path: "notes.txt" });
await node.fs.writeFile({ path: "notes.bak", data: text });
```

| Action | Access | Result |
|---|---|---|
| `fs.readFile({ path, encoding?, maxBytes? })` | read | The file's text. Pass `encoding: "base64"` for a binary file |
| `fs.readdir({ path, withFileTypes? })` | read | The names in a directory, or an entry for each with its kind |
| `fs.stat({ path })`, `fs.lstat({ path })` | read | Size, times, mode, and kind |
| `fs.exists({ path })` | read | `true` or `false` |
| `fs.access({ path })` | read | `{ ok: true }`, or the call rejects |
| `fs.writeFile({ path, data, encoding? })`, `fs.appendFile(…)` | write | `{ ok: true, path }` |
| `fs.mkdir({ path, recursive? })` | write | `{ ok: true, path }`. `recursive` defaults to `true` |
| `fs.rm({ path, recursive?, force? })`, `fs.unlink({ path })` | write | `{ ok: true, path }` |
| `fs.rename({ from, to })`, `fs.copyFile({ from, to })` | write | `{ ok: true, from, to }` |

`fs.readFile` refuses a file larger than `maxBytes`, 10 MiB by default, and names its size. Read a larger file in parts with `bash.run`, or query it with `duckdb.query`.

## Make a request

`node.fetch` makes an HTTP request and returns the response:

```js
const { status, body } = await node.fetch({ url: "https://api.example.com/health" });
```

| Input | Meaning |
|---|---|
| `url`, `method`, `headers`, `body` | The request. `body` is text |
| `timeoutMs` | Give up after this long. The default is no limit of its own |
| `maxBytes` | The largest body to return as `body`. The default is 10 MiB |

| Result | Contents |
|---|---|
| `ok`, `status`, `statusText`, `headers` | The response's status and headers |
| `body` | The body, when it is text within `maxBytes`. Parsed when the response says JSON |
| `bodyPath` | A file with all of the body, when it is not text or is larger than `maxBytes` |
| `bytes` | The body's size |

A response has `body` or `bodyPath`, never part of a body. The file is in the host's [output directory](../../docs/sdk.md#limit-a-runs-result), and only your account can read it.

## Use the other actions

The remaining actions follow the Node.js functions they are named after:

| Group | Actions |
|---|---|
| `path` | `join`, `resolve`, `normalize`, `dirname`, `basename`, `extname`, `relative`, `isAbsolute`, `parse`, `format`, `constants` |
| `os` | `info`, `platform`, `arch`, `homedir`, `tmpdir`, `userInfo` |
| `process` | `cwd`, `env` |
| `crypto` | `randomUUID`, `randomBytes`, `hash` |

`path.join` and `path.resolve` take `{ segments: [...] }`. `process.env({ name })` returns one variable, and without `name` all of them.

Inspect any action from code with `actions.describe("node.fs.readFile")`.

## Understand how a call lives

| Rule | Meaning |
|---|---|
| Every call stands alone | Nothing stays open from one call to the next |
| A call ends with its run | A request, a read, or a write still under way is stopped when the run ends |
| A result is bounded | A file over the limit is refused, and a large or binary response body is a file |
| Input is checked | A missing, misspelled, or unknown field is refused before anything runs |

## Configure the connection

Add a connection to set where relative paths resolve from. The value is optional:

```bash
codemode connection add node --plugin node --set cwd=/srv/app
```

| Field | Meaning |
|---|---|
| `cwd` | The directory relative paths resolve from, and what `process.cwd` returns. The default is the directory codemode runs in |

## Run commands

The package runs no commands. Install [`codemode-bash`](../codemode-bash) or [`codemode-powershell`](../codemode-powershell) for that. Their `run` action returns the exit code, ends the command with the run, and bounds its output.

## Understand the limits

- `cwd` is where relative paths start, not a boundary. An absolute path or `..` reaches any file the codemode process can.
- `process.env` returns every environment variable of the codemode process, secrets included.
- `fetch` sends whatever headers the code passes, to any URL.
- Output files are not removed. The host that names the directory clears it.
- Windows is untested.
