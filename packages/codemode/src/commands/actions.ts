import chalk from "chalk";
import { loadConfig } from "../config/loader.js";
import { loadAllPlugins } from "../plugin/loader.js";
import { registry } from "../plugin/registry.js";
import { helpInputs } from "../plugin/schema.js";
import { printJson } from "../utils/output.js";
import { withCliMcp } from "./mcp.js";
import { cliPackageManager, temporarySources } from "./packages.js";

export async function actions(options: {
  json?: boolean;
  connected?: boolean;
  packages?: string[];
}): Promise<void> {
  // Listing a server's tools needs its tool list: a server with none
  // cached is connected to once, and its session closed again.
  await withCliMcp((mcp) =>
    loadAllPlugins({
      packages: cliPackageManager({ quiet: options.json }),
      temporaryPackages: temporarySources(options.packages),
      mcp,
    }),
  );
  const all = registry.getAllActions();
  // A configured MCP server is in use whether or not it needs a connection.
  const connectedPlugins = options.connected
    ? new Set([
        ...loadConfig().connections.map((c) => c.plugin),
        ...registry
          .listPlugins()
          .filter((plugin) => plugin.sourceInfo?.origin === "mcp")
          .map((plugin) => plugin.name),
      ])
    : null;
  const filtered = connectedPlugins
    ? all.filter(({ plugin }) => connectedPlugins.has(plugin))
    : all;

  if (options.json) {
    printJson(
      filtered.map(({ plugin, action }) => ({
        plugin,
        action: action.name,
        access: action.access,
        description: action.description,
        inputSchema: action.inputSchema,
      })),
    );
    return;
  }

  if (filtered.length === 0) {
    if (options.connected) {
      console.log("No actions found for connected services.");
      console.log(
        "Add a connection first: codemode connection add <name> -p <plugin>",
      );
    } else {
      console.log("No actions registered. Install a plugin first.");
    }
    return;
  }

  const grouped = new Map<string, typeof filtered>();
  for (const entry of filtered) {
    const list = grouped.get(entry.plugin) ?? [];
    list.push(entry);
    grouped.set(entry.plugin, list);
  }

  for (const [plugin, entries] of grouped) {
    console.log(chalk.bold(`\n${plugin}`));
    for (const { action } of entries) {
      const path = chalk.cyan(`${plugin}.${action.name}`);
      const access = action.access ? chalk.dim(` [${action.access}]`) : "";
      const desc = action.description
        ? chalk.dim(` — ${action.description}`)
        : "";
      // The notation `actions.describe` gives its signatures.
      const inputs = Object.entries(helpInputs(action.inputSchema));
      const schema = inputs.length
        ? chalk.dim(
            ` (${inputs
              .map(
                ([key, input]) =>
                  `${key}${input.required ? "" : "?"}: ${input.displayType ?? input.type}`,
              )
              .join(", ")})`,
          )
        : "";
      console.log(`  ${path}${access}${schema}${desc}`);
    }
  }
  console.log();
}
