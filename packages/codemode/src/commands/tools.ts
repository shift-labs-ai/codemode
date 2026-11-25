import { join } from "node:path";
import chalk from "chalk";
import { userConfigDir } from "../config/loader.js";
import { loadAllPlugins } from "../plugin/loader.js";
import { registry } from "../plugin/registry.js";
import {
  type PluginTool,
  PluginTools,
  ToolError,
  ToolManager,
} from "../tools/manager.js";
import { environment } from "../utils/deprecation.js";
import {
  failCommand,
  megabytes,
  printJson,
  printSuccess,
} from "../utils/output.js";
import { cliPackageManager } from "./packages.js";

/** The tool manager the CLI uses: `tools` in `~/.codemode`. */
export function cliToolManager(options: { quiet?: boolean } = {}): ToolManager {
  return new ToolManager({
    dir: join(userConfigDir(), "tools"),
    offline: environment("OFFLINE") === "1",
    onDownload: options.quiet
      ? undefined
      : (name, tool) =>
          console.error(
            chalk.dim(
              `Downloading ${name} from ${tool.hosts.join(", ")} (${megabytes(tool.size ?? 0)})…`,
            ),
          ),
  });
}

/** The tools of every plugin the CLI loads: local files and configured packages. */
async function loadedTools(json?: boolean): Promise<PluginTools> {
  await loadAllPlugins({ packages: cliPackageManager({ quiet: json }) });
  return new PluginTools(
    () => registry.listPlugins(),
    cliToolManager({ quiet: json }),
  );
}

function fail(error: unknown, json?: boolean): never {
  failCommand(error, {
    json,
    code: error instanceof ToolError ? error.code : undefined,
  });
}

function state(tool: PluginTool): string {
  if (tool.installed) return chalk.green("installed");
  return tool.supported
    ? chalk.yellow("not installed")
    : chalk.dim(`no build for ${tool.platform}`);
}

function printTools(tools: PluginTool[]): void {
  for (const tool of tools) {
    const from = tool.supported
      ? chalk.dim(`  ← ${tool.hosts.join(", ")} (${megabytes(tool.size ?? 0)})`)
      : "";
    console.log(
      `  ${chalk.bold(tool.plugin.padEnd(16))} ${tool.name.padEnd(16)} ${state(tool)}${from}`,
    );
    if (tool.path) console.log(`  ${"".padEnd(33)} ${chalk.dim(tool.path)}`);
  }
}

export async function toolsList(options: { json?: boolean }): Promise<void> {
  try {
    const tools = (await loadedTools(options.json)).list();
    if (options.json) return printJson(tools);
    if (!tools.length) {
      console.log("No loaded plugin declares a program.");
      return;
    }
    printTools(tools);
    if (tools.some((tool) => tool.supported && !tool.installed))
      console.log("\nInstall what is missing: codemode tools install");
  } catch (error) {
    fail(error, options.json);
  }
}

export async function toolsInstall(
  name: string | undefined,
  options: { json?: boolean },
): Promise<void> {
  try {
    const tools = await loadedTools(options.json);
    const installed = await tools.install(name);
    if (options.json) return printJson(installed);
    printTools(installed);
    if (!installed.length) console.log("No loaded plugin declares a program.");
  } catch (error) {
    fail(error, options.json);
  }
}

export async function toolsRemove(
  name: string,
  options: { json?: boolean },
): Promise<void> {
  try {
    const removed = await (await loadedTools(options.json)).remove(name);
    if (options.json) return printJson(removed);
    printSuccess(`Removed ${chalk.bold(name)}`);
  } catch (error) {
    fail(error, options.json);
  }
}

export async function toolsEntry(url: string): Promise<void> {
  try {
    printJson(await cliToolManager({ quiet: true }).describe(url));
  } catch (error) {
    fail(error, true);
  }
}
