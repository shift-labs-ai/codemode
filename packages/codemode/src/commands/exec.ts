import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findConfigDir, loadConfig } from "../config/loader.js";
import { FileConnectionProvider } from "../connections/file.js";
import { ExecutionEngine } from "../core/engine.js";
import { enabledBuiltins, loadAllPlugins } from "../plugin/loader.js";
import { registry } from "../plugin/registry.js";
import { printError, printJson } from "../utils/output.js";
import { cliMcpManager } from "./mcp.js";
import { cliPackageManager, temporarySources } from "./packages.js";

export async function exec(
  code: string,
  options: {
    file?: boolean;
    json?: boolean;
    quiet?: boolean;
    packages?: string[];
  },
): Promise<void> {
  if (options.file) {
    if (!existsSync(code)) {
      printError(`File not found: ${code}`);
      process.exit(1);
    }
    code = readFileSync(code, "utf-8");
  }

  const config = loadConfig();
  const mcp = cliMcpManager();
  let failed = false;
  // A stdio MCP server is a child process: its session is closed before the
  // command ends, whichever way it ends, so none is left running.
  try {
    failed = !(await run(code, config, mcp, options));
  } finally {
    await mcp.close();
  }
  if (failed) process.exitCode = 1;
}

/** Runs the code and prints its outcome. Answers whether it succeeded. */
async function run(
  code: string,
  config: ReturnType<typeof loadConfig>,
  mcp: ReturnType<typeof cliMcpManager>,
  options: { json?: boolean; quiet?: boolean; packages?: string[] },
): Promise<boolean> {
  await loadAllPlugins({
    builtinAllowlist: enabledBuiltins(config.connections),
    packages: cliPackageManager({ quiet: options.quiet || options.json }),
    temporaryPackages: temporarySources(options.packages),
    mcp,
  });
  const configDir = findConfigDir() ?? join(process.cwd(), ".codemode");
  const engine = new ExecutionEngine(registry, config, {
    connectionProvider: new FileConnectionProvider(
      join(configDir, "config.json"),
    ),
  });

  const result = await engine.execute(code);
  engine.dispose();

  if (result.error) {
    if (options.json) {
      printJson({ error: result.error, logs: result.logs });
    } else {
      if (result.logs.length > 0 && !options.quiet) {
        for (const log of result.logs) console.error(log);
      }
      printError(result.error);
    }
    return false;
  }

  if (options.json) {
    printJson({ result: result.result, logs: result.logs });
  } else {
    if (result.logs.length > 0 && !options.quiet) {
      for (const log of result.logs) console.error(log);
    }
    if (result.result !== null && result.result !== undefined) {
      console.log(
        typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result, null, 2),
      );
    }
  }
  return true;
}
