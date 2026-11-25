# Binaries

Binaries are the programs a plugin runs: a command-line program such as `wacli` or `uv`, which npm cannot install. A package declares each one as data in its `package.json`, with a download address and a SHA-256 for every platform it supports.

Codemode downloads a binary only when the host asks for it, checks the download against the declaration, and keeps the program in a folder of its own. An action runs a binary with `runBinary()` and never causes a download.

## Declare a binary

Add each binary under `codemode.binaries` in the package's `package.json`, by the name the plugin uses for it:

```json
{
  "name": "@example/codemode-notes",
  "codemode": {
    "plugins": ["./src/index.ts"],
    "binaries": {
      "notes": {
        "check": ["--version"],
        "platforms": {
          "linux-x86_64": {
            "size": 9348860,
            "hash": "sha256",
            "digest": "515405c5a33c7f651a368484740db662736f50c275be5a0504fb0a84dce47013",
            "format": "tar.gz",
            "path": "bin/notes",
            "providers": [
              { "url": "https://example.com/releases/v1.2.0/notes_linux_amd64.tar.gz" }
            ]
          }
        }
      }
    }
  }
}
```

An entry under `platforms` has the fields of a platform entry in a [DotSlash](https://dotslash-cli.com) file:

| Field | Value |
|---|---|
| `size` | The download's size in bytes |
| `hash` | `sha256` |
| `digest` | The download's SHA-256, in lowercase hex |
| `format` | How the download is packed. Leave it out when the download is the program itself |
| `path` | The program inside an archive, or the name a single file is given |
| `providers` | One or more `{ "url": "https://…" }`, tried in order until one answers the declared bytes |

`check` is optional. It lists arguments the program is run with once after it is unpacked. The program must exit with status 0, or it is not installed, so a build that cannot run on the host is reported when it is installed and not when an action first needs it.

Name each platform by its system and processor:

| Key | Host |
|---|---|
| `macos-aarch64`, `macos-x86_64` | macOS on Apple silicon, or on Intel |
| `linux-x86_64`, `linux-aarch64` | Linux on x64, or on ARM64 |
| `windows-x86_64`, `windows-aarch64` | Windows on x64, or on ARM64 |

Choose the format the download has:

| Format | Download |
|---|---|
| none | The program itself |
| `gz` | The program, gzipped |
| `tar`, `tar.gz`, `tar.bz2`, `tar.xz`, `tar.zst` | A tar archive that holds the program |
| `zip` | A zip archive that holds the program |

`codemode binaries entry` downloads an artifact and prints its entry, with `path` left for you to fill in:

```bash
codemode binaries entry https://example.com/releases/v1.2.0/notes_linux_amd64.tar.gz
```

## Use a binary in a plugin

Read the declarations in the plugin, the way it reads its version, and run a binary by its name:

```typescript
import type { CodemodePluginAPI } from "@shiftlabs/codemode";
import {
  packageBinaries,
  packageVersion,
  runBinary,
} from "@shiftlabs/codemode/utils/cli";

export default function notes(rl: CodemodePluginAPI) {
  rl.setName("notes");
  rl.setVersion(packageVersion(import.meta.url));
  rl.setBinaries(packageBinaries(import.meta.url));

  rl.registerAction("list", {
    access: "read",
    async execute(input, ctx) {
      const { stdout } = await runBinary(ctx, "notes", ["list", "--json"]);
      return JSON.parse(stdout);
    },
  });
}
```

`packageBinaries(import.meta.url)` reads `codemode.binaries` from the `package.json` one directory above the module and refuses a declaration it cannot use, naming the field.

`runBinary(ctx, name, args, options)` starts an installed binary as [`runCommand`](plugins.md#run-a-program) starts a program: with an argument list and no shell. It answers `stdout`, `stderr`, `exitCode`, `truncated`, and `wallTimeMs`. A binary that exits with a failure still returns. The call rejects when the binary is not installed, with the command that installs it, when it declares no build for the host's platform, and when it cannot start or outlives `timeoutMs`.

| Option | Purpose |
|---|---|
| `cwd` | Working directory. The default is the directory codemode runs in |
| `env` | Variables the binary needs. It starts with a short list of the host's, such as `PATH`, `HOME`, and the proxy variables, and with these |
| `timeoutMs` | Ends the binary, and what it started, after this long |

The binary ends with the run that started it. `stdout` and `stderr` each hold up to `ctx.maxOutputBytes`. Past that, each is its last lines, and `fullOutputPath` names a file with all of `stdout`.

`ctx.binary(name)` answers the absolute path of an installed binary, for an action that must start it another way. It rejects as `runBinary` does.

## Install binaries

Installing a package shows the binaries its plugins declare and the hosts they are downloaded from. It does not download them. Install them as a step of their own:

```bash
codemode binaries list
codemode binaries install
```

| Task | Command |
|---|---|
| List declared binaries and whether each is installed | `codemode binaries list` |
| Install every declared binary, or one | `codemode binaries install [name]` |
| Delete an installed binary | `codemode binaries remove <name>` |
| Print a platform entry for a URL | `codemode binaries entry <url>` |

To install a binary, codemode:

1. downloads the build for the host's platform from its first provider that answers;
2. refuses it unless its size and SHA-256 are the declared ones;
3. unpacks it beside its final place;
4. runs the binary's `check`, when it declares one;
5. moves it into place.

A download that fails any step leaves nothing behind. Binaries are kept in `~/.codemode/bin`, in a folder named for what the declaration pins, so two plugins that declare the same build share one copy and two versions sit side by side.

Set `CODEMODE_OFFLINE=1` to refuse every download.

## Embed the binary manager

A `Codemode` instance exposes the binaries of its plugins as `binaries`:

```typescript
import { Codemode, BinaryManager } from "@shiftlabs/codemode";

const codemode = Codemode.create({
  plugins,
  binaries: new BinaryManager({ dir: "/data/codemode/bin" }),
});

await codemode.binaries.install();
console.log(codemode.binaries.list());
```

| Method | Result |
|---|---|
| `binaries.list()` | Each declared binary with `plugin`, `name`, `platform`, `supported`, `hosts`, `size`, `installed`, and `path` when installed |
| `binaries.install(name?)` | Installs one binary, or every binary that has a build for the host, and answers their state |
| `binaries.remove(name)` | Deletes one installed binary, and answers whether there was one |

`BinaryManager` is the library behind them. It never prompts or prints, and it downloads only when `install()` or `describe()` is called.

| Option | Purpose |
|---|---|
| `dir` | The folder installed binaries are kept in, or a function that names it when a binary is first asked about |
| `fetch` | Downloads artifacts. Replace it to use a proxy or a mirror. The default is the global `fetch` |
| `runner` | Runs `tar` and `unzip`, and each binary's check. Replace it to run them in a sandbox |
| `offline` | Refuses every download |
| `onDownload` | Called when a download is about to start |

Without a `binaries` option, an instance keeps binaries in `bin` in the user's codemode folder, which it looks for only when a binary is first asked about. Failures are `BinaryError` values with a `code`: `not_declared`, `unsupported_platform`, `not_installed`, `offline`, `download_failed`, `unpack_failed`, `check_failed`, or `aborted`.

## Understand the limits

- A binary is a program that runs with the permissions of the codemode process. Codemode does not sandbox it.
- A host's [`spawnHook`](sdk.md#shape-how-commands-start) shapes a binary that `runBinary` starts. It does not see a binary an action starts itself from `ctx.binary()`.
- A download is verified once, when it is installed. A program changed on disk afterwards is not detected.
- The only hash is SHA-256, and a provider is an `https` URL. Other providers a DotSlash file can name are passed over.
- The host's `tar` unpacks archives. A zip needs `unzip`, or a `tar` that reads zip, as on macOS and Windows. The `bz2`, `xz`, and `zst` archives need those programs installed.
- A platform key names a system and a processor. It cannot say which C library or system version a build needs: use `check` so the program reports that itself.
- A binary's check runs with a short list of environment variables, such as `PATH` and `HOME`, not with the rest of the host's environment.
- There is no update command. A new version of a binary is a new declaration in a new version of its package, and the earlier version's folder stays until it is deleted.
- `packageBinaries` reads the `package.json` one directory above the module, so the plugin's module sits one folder below it, as `src/index.ts` does.

See [Security](security.md).
