# codemode-node

A [codemode](../../README.md) package with one plugin, `node`, whose one action runs JavaScript in Node.js on the machine codemode runs on.

Install it where code should use the filesystem, the network, or any Node.js module. It is not a sandbox: a script runs with the permissions of the codemode process.

## Install

Install the package. It needs no connection:

```bash
codemode install npm:@shiftlabs/codemode-node
```

It needs a codemode newer than 0.46.0, and Node.js 20.19 or newer. Through 0.46.0, `node` was a bundled plugin with an action for each function; see [Migrate from runline](../../docs/migrating-from-runline.md#install-the-node-plugin).

## Run a script

`node.run` returns what the script wrote and how it ended:

```bash
codemode exec 'return await node.run({ command: "console.log(require(\"node:os\").platform())" })'
```

```json
{
  "output": "linux\n",
  "exitCode": 0,
  "truncated": false,
  "wallTimeMs": 48
}
```

| Input | Meaning |
|---|---|
| `command` | The script to run |
| `cwd` | Working directory. A relative path resolves from the connection's `cwd` |
| `timeoutMs` | End the script, and what it started, after this long. The default is no limit of its own |

A script can use `require`, or `import` and a top-level `await`, but not `require` together with a top-level `await`. Print what the calling code needs, as JSON when it is data:

```js
const { output } = await node.run({
  command: `
    import { readdir, stat } from "node:fs/promises";
    const names = await readdir(".");
    const sizes = await Promise.all(names.map(async (name) => [name, (await stat(name)).size]));
    console.log(JSON.stringify(Object.fromEntries(sizes)));
  `,
});
const sizes = JSON.parse(output);
```

Each call is a new process, so variables do not carry from one call to the next.

## Handle results

A script that fails still returns, so check `exitCode`:

| Outcome | Result |
|---|---|
| The script ends, with any exit code | Returns `output`, `exitCode`, `truncated`, and `wallTimeMs` |
| The script throws, or cannot be parsed | Returns `exitCode` 1, with the error in `output` |
| A signal ends the script | Returns `exitCode` 128 plus the signal's number |
| Node.js cannot start, or `cwd` does not exist | The call rejects |
| The script outlives `timeoutMs` | The call rejects, with what the script wrote |
| The run ends first | The script, and what it started, is ended |

`output` is stdout and stderr together, and code gets all of it up to what the host lets an action hold, [8 MiB by default](../../docs/sdk.md#limit-what-an-action-holds). Past that it is the last lines, and `fullOutputPath` names a file with all of it.

What a run returns is a separate matter: codemode cuts it to the host's [output limit](../../docs/sdk.md#limit-a-runs-result), 2,000 lines or 50 KB by default. A returned `output` past that is cut to its last lines, beside its `exitCode`, with all of it in a file.

## Configure the connection

Add a connection to set where scripts run or which Node.js runs them. Both values are optional:

```bash
codemode connection add node --plugin node --set cwd=/srv/app
```

| Field | Meaning |
|---|---|
| `cwd` | The directory scripts run in. The default is the directory codemode runs in |
| `shell` | Path of the Node.js to run. The default is `node` on `PATH` |

## Understand the limits

- A script sees the whole environment of the codemode process.
- The action is labelled `write`, whatever the script does.
- The script arrives on stdin, so it cannot read stdin itself.
- A script resolves packages from its working directory, not from codemode.
- Windows is untested.
