import { join } from "node:path";
import chalk from "chalk";
import {
  BinaryError,
  BinaryManager,
  PluginBinaries,
  type PluginBinary,
} from "../binaries/manager.js";
import { userConfigDir } from "../config/loader.js";
import { loadAllPlugins } from "../plugin/loader.js";
import { registry } from "../plugin/registry.js";
import { environment } from "../utils/deprecation.js";
import {
  downloadOrigin,
  failCommand,
  printJson,
  printSuccess,
} from "../utils/output.js";
import { cliPackageManager } from "./packages.js";

/** The binary manager the CLI uses: `bin` in `~/.codemode`. */
export function cliBinaryManager(
  options: { quiet?: boolean } = {},
): BinaryManager {
  return new BinaryManager({
    dir: join(userConfigDir(), "bin"),
    offline: environment("OFFLINE") === "1",
    onDownload: options.quiet
      ? undefined
      : (name, binary) =>
          console.error(
            chalk.dim(`Downloading ${name} from ${downloadOrigin(binary)}…`),
          ),
  });
}

/** The binaries of every plugin the CLI loads. */
async function loadedBinaries(quiet?: boolean): Promise<PluginBinaries> {
  await loadAllPlugins({ packages: cliPackageManager({ quiet }) });
  return new PluginBinaries(
    () => registry.listPlugins(),
    cliBinaryManager({ quiet }),
  );
}

function fail(error: unknown, json?: boolean): never {
  failCommand(error, {
    json,
    code: error instanceof BinaryError ? error.code : undefined,
  });
}

function state(binary: PluginBinary): string {
  if (binary.installed) return chalk.green("installed");
  return binary.supported
    ? chalk.yellow("not installed")
    : chalk.dim(`no build for ${binary.platform}`);
}

function printBinaries(binaries: PluginBinary[]): void {
  if (!binaries.length) {
    console.log("No loaded plugin declares a binary.");
    return;
  }
  for (const binary of binaries) {
    const from = binary.supported
      ? chalk.dim(`  ← ${downloadOrigin(binary)}`)
      : "";
    console.log(
      `  ${chalk.bold(binary.plugin.padEnd(16))} ${binary.name.padEnd(16)} ${state(binary)}${from}`,
    );
    if (binary.path)
      console.log(`  ${"".padEnd(33)} ${chalk.dim(binary.path)}`);
  }
}

export async function binariesList(options: { json?: boolean }): Promise<void> {
  try {
    const binaries = (await loadedBinaries(options.json)).list();
    if (options.json) return printJson(binaries);
    printBinaries(binaries);
    if (binaries.some((binary) => binary.supported && !binary.installed))
      console.log("\nInstall what is missing: codemode binaries install");
  } catch (error) {
    fail(error, options.json);
  }
}

export async function binariesInstall(
  name: string | undefined,
  options: { json?: boolean; quiet?: boolean },
): Promise<void> {
  try {
    const binaries = await loadedBinaries(options.quiet || options.json);
    const installed = await binaries.install(name);
    if (options.json) return printJson(installed);
    printBinaries(installed);
  } catch (error) {
    fail(error, options.json);
  }
}

export async function binariesRemove(
  name: string,
  options: { json?: boolean },
): Promise<void> {
  try {
    const removed = await (await loadedBinaries(options.json)).remove(name);
    if (!removed) fail(new Error(`${name} is not installed`), options.json);
    if (options.json) printJson({ ok: true, removed: name });
    else printSuccess(`Removed ${chalk.bold(name)}`);
  } catch (error) {
    fail(error, options.json);
  }
}

export async function binariesEntry(
  url: string,
  options: { json?: boolean },
): Promise<void> {
  try {
    printJson(await cliBinaryManager({ quiet: true }).describe(url));
  } catch (error) {
    fail(error, options.json);
  }
}
