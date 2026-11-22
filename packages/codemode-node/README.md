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
| `fs.readFile({ path, encoding? })` | read | The file's text. Pass `encoding: "base64"` for a binary file |
| `fs.readdir({ path, withFileTypes? })` | read | The names in a directory, or an entry for each with its kind |
| `fs.stat({ path })`, `fs.lstat({ path })` | read | Size, times, mode, and kind |
| `fs.exists({ path })` | read | `true` or `false` |
| `fs.access({ path })` | read | `{ ok: true }`, or the call rejects |
| `fs.writeFile({ path, data, encoding? })`, `fs.appendFile(…)` | write | `{ ok: true, path }` |
| `fs.mkdir({ path, recursive? })` | write | `{ ok: true, path }`. `recursive` defaults to `true` |
| `fs.rm({ path, recursive?, force? })`, `fs.unlink({ path })` | write | `{ ok: true, path }` |
| `fs.rename({ from, to })`, `fs.copyFile({ from, to })` | write | `{ ok: true, from, to }` |

A relative path resolves from the directory codemode runs in.

## Use the other actions

The remaining actions follow the Node.js functions they are named after:

| Group | Actions |
|---|---|
| `path` | `join`, `resolve`, `normalize`, `dirname`, `basename`, `extname`, `relative`, `isAbsolute`, `parse`, `format`, `constants` |
| `os` | `info`, `platform`, `arch`, `homedir`, `tmpdir`, `userInfo` |
| `process` | `cwd`, `env` |
| `crypto` | `randomUUID`, `randomBytes`, `hash` |
| `fetch` | One action, labelled `write` |

`path.join` and `path.resolve` take `{ segments: [...] }`. `process.env({ name })` returns one variable, and without `name` all of them.

`node.fetch({ url, method?, headers?, body? })` returns `ok`, `status`, `statusText`, `headers`, and `body`, which is parsed when the response is JSON:

```js
const { status, body } = await node.fetch({ url: "https://api.example.com/health" });
```

Inspect any action from code with `actions.describe("node.fs.readFile")`.

## Run commands

The package runs no commands. Install [`codemode-bash`](../codemode-bash) or [`codemode-powershell`](../codemode-powershell) for that. Their `run` action returns the exit code, ends the command with the run, and bounds its output.

## Understand the limits

- `process.env` returns every environment variable of the codemode process, secrets included.
- `fetch` sends whatever headers the code passes, to any URL.
- A response or file is read whole into memory.
- Windows is untested.
