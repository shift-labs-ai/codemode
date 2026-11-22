# codemode-bash

A [codemode](../../README.md) package with one plugin, `bash`, whose one action runs a bash command on the machine codemode runs on.

Install it where code should run commands. It is not a sandbox: a command runs with the permissions of the codemode process.

## Install

Install the package. It needs no connection:

```bash
codemode install npm:@shiftlabs/codemode-bash
```

It needs a codemode newer than 0.46.0.

## Run a command

`bash.run` returns what the command wrote and how it ended:

```bash
codemode exec 'return await bash.run({ command: "git status --short" })'
```

```json
{
  "output": " M README.md\n",
  "exitCode": 0,
  "truncated": false,
  "wallTimeMs": 14
}
```

| Input | Meaning |
|---|---|
| `command` | The script to run |
| `cwd` | Working directory. A relative path resolves from the connection's `cwd` |
| `timeoutMs` | End the command, and what it started, after this long. The default is no limit of its own |

Each call is a new process, so `cd` and variables do not carry from one call to the next. Put steps that depend on each other in one command.

## Handle results

A command that exits with a failure still returns, so check `exitCode`:

```js
const found = await bash.run({ command: "grep -rn TODO src" });
if (found.exitCode === 1) return "nothing to do";
```

| Outcome | Result |
|---|---|
| The command exits, with any exit code | Returns `output`, `exitCode`, `truncated`, and `wallTimeMs` |
| A signal ends the command | Returns `exitCode` 128 plus the signal's number |
| The shell cannot start, or `cwd` does not exist | The call rejects |
| The command outlives `timeoutMs` | The call rejects, with what the command wrote |
| The run ends first | The command, and what it started, is ended |

`output` is stdout and stderr together. Past 1 MiB it keeps its start and end around a note of what was left out, and `fullOutputPath` names a file with all of it, in the host's [output directory](../../docs/sdk.md#limit-a-runs-result).

## Configure the connection

Add a connection to set where commands run or which shell runs them. Both values are optional:

```bash
codemode connection add bash --plugin bash --set cwd=/srv/app
```

| Field | Meaning |
|---|---|
| `cwd` | The directory commands run in. The default is the directory codemode runs in |
| `shell` | Path of the shell to run. The default is `/bin/bash`, then `bash` on `PATH`, then `sh`. On Windows it is Git Bash, then `bash.exe` on `PATH` |

## Understand the limits

- A command sees the whole environment of the codemode process.
- The action is labelled `write`, whatever the command does.
- Windows is untested.
