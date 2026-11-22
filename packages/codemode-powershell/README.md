# codemode-powershell

A [codemode](../../README.md) package with one plugin, `powershell`, whose one action runs a PowerShell command on the machine codemode runs on.

Install it where code should run commands. It is not a sandbox: a command runs with the permissions of the codemode process.

## Install

Install the package. It needs no connection:

```bash
codemode install npm:@shiftlabs/codemode-powershell
```

It needs a codemode newer than 0.46.0, and a PowerShell: `pwsh` on any system, or Windows PowerShell 5.1.

## Run a command

`powershell.run` returns what the command wrote and how it ended:

```bash
codemode exec 'return await powershell.run({ command: "Get-ChildItem *.md | Select-Object -ExpandProperty Name" })'
```

```json
{
  "output": "README.md\n",
  "exitCode": 0,
  "truncated": false,
  "wallTimeMs": 412
}
```

| Input | Meaning |
|---|---|
| `command` | The script to run |
| `cwd` | Working directory. A relative path resolves from the connection's `cwd` |
| `timeoutMs` | End the command, and what it started, after this long. The default is no limit of its own |

Each call is a new process, so `Set-Location` and variables do not carry from one call to the next. Put steps that depend on each other in one command.

PowerShell runs with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Output is UTF-8. PowerShell and the programs it starts run with `NO_COLOR=1`, so PowerShell 7.4 and newer write errors as plain text.

## Handle results

A command that ends with a failure still returns, so check `exitCode`. PowerShell decides it by the command's last statement:

| The command | `exitCode` |
|---|---|
| Calls `exit 3` | 3 |
| Ends with a statement that succeeded | 0 |
| Ends with a statement that failed, or throws | 1 |
| Ends with a program that exited 5 | 1 |
| Cannot be parsed | 1 |

End a command with `exit $LASTEXITCODE` to return the exit code of the program it ran:

```js
const built = await powershell.run({ command: "dotnet build; exit $LASTEXITCODE" });
if (built.exitCode !== 0) return built.output;
```

| Outcome | Result |
|---|---|
| The command ends, with any exit code | Returns `output`, `exitCode`, `truncated`, and `wallTimeMs` |
| PowerShell cannot start, or `cwd` does not exist | The call rejects |
| The command outlives `timeoutMs` | The call rejects, with what the command wrote |
| The run ends first | The command, and what it started, is ended |

`output` is stdout and stderr together, and code gets all of it up to what the host lets an action hold, [8 MiB by default](../../docs/sdk.md#limit-what-an-action-holds). Past that it is the last lines, and `fullOutputPath` names a file with all of it.

What a run returns is a separate matter: codemode cuts it to the host's [output limit](../../docs/sdk.md#limit-a-runs-result), 2,000 lines or 50 KB by default. A returned `output` past that is cut to its last lines, beside its `exitCode`, with all of it in a file.

## Configure the connection

Add a connection to set where commands run or which PowerShell runs them. Both values are optional:

```bash
codemode connection add powershell --plugin powershell --set cwd=/srv/app
```

| Field | Meaning |
|---|---|
| `cwd` | The directory commands run in. The default is the directory codemode runs in |
| `shell` | Path of the PowerShell to run. The default is `pwsh` on `PATH`, then `powershell` on `PATH`. On Windows it is PowerShell 7 where it installs, before Windows PowerShell |

## Understand the limits

- A command sees the whole environment of the codemode process.
- The action is labelled `write`, whatever the command does.
- A command cannot start with a `using` statement or a `param` block. PowerShell allows them only at the start of a script, and the line that sets the output encoding comes first. Write the full type name instead.
- In Windows PowerShell 5.1, a program that writes to a redirected stderr and exits 0 counts as a success.
- Windows and Windows PowerShell 5.1 are untested.
