import { join } from "node:path";
import {
  findConfigDir,
  loadConfigFrom,
  userConfigDir,
} from "./config/loader.js";
import { isProjectTrusted } from "./config/trust.js";
import type { CodemodeConfig } from "./config/types.js";
import { DEFAULT_CONFIG } from "./config/types.js";
import { FileConnectionProvider } from "./connections/file.js";
import { MemoryConnectionProvider } from "./connections/memory.js";
import type { ConnectionProvider } from "./connections/types.js";
import {
  type EngineHooks,
  type ExecuteResult,
  ExecutionEngine,
} from "./core/engine.js";
import { McpManager } from "./mcp/manager.js";
import { PackageManager } from "./packages/manager.js";
import type { PluginFunction } from "./plugin/api.js";
import { resolvePluginExport } from "./plugin/api.js";
import { discoverPlugins, enabledBuiltins } from "./plugin/loader.js";
import { PluginRegistry } from "./plugin/registry.js";
import type {
  ActionAccess,
  ConnectionConfig,
  InputSchema,
  PluginDef,
} from "./plugin/types.js";
import type { OutputLimitSetting } from "./utils/output-limit.js";

export interface CodemodeOptions {
  plugins?: Array<PluginDef | PluginFunction>;
  /** Initial process-local connections. No environment lookup or disk writes. */
  connections?: ConnectionConfig[];
  /** Host-owned credentials; mutually exclusive with initial connections. */
  connectionProvider?: ConnectionProvider;
  /**
   * Host-signed requests, built per action call of a plugin that declares
   * its credential and handed to the action as `ctx.credentials`. For
   * hosts that keep credentials outside the process running actions;
   * absent, plugins sign with their connection.
   */
  credentialBroker?: EngineHooks["credentialBroker"];
  timeoutMs?: number;
  memoryLimitBytes?: number;
  /**
   * Bodies one pooled worker may run before it is retired. See
   * `ExecutionEngine` — this bounds cross-run contamination, not memory.
   */
  maxRunsPerWorker?: number;
  /**
   * Where output files are written: a command's whole output, a run's whole
   * result, generated media. Actions read it as `ctx.outputDir`. Default:
   * the system's temporary directory.
   */
  outputDir?: string;
  /**
   * How much a run hands back, for the sake of whoever reads it. A run's
   * result, error and logs are each cut to this many lines and bytes,
   * whichever comes first, with the whole in an output file. Either number
   * can be set alone, and `false` sets no limit. Default: 2000 lines and
   * 50 KB. Code inside a run works with whole values.
   */
  outputLimit?: OutputLimitSetting;
  /**
   * How much of what it produces one action may hold in memory and hand to
   * the code that called it, for the sake of the process. An action that
   * produces output in parts, such as a command or a query, keeps what is
   * past it in an output file, and reads this as `ctx.maxOutputBytes`.
   * Default: 8 MiB.
   */
  maxActionOutputBytes?: number;
  /**
   * Observer fired in the host process for every action invocation
   * that enters a plugin's `execute()` — unknown paths and failed
   * input validation never reach plugin code and are not reported.
   * Exceptions thrown by the observer are swallowed: observability
   * never breaks a run. Not part of `CodemodeConfig` on purpose —
   * config round-trips through JSON (`fromProject`), functions do not.
   */
  onAction?: EngineHooks["onAction"];
}

export interface CodemodeExecuteOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  /** Delivered to every action's `ctx.context` for this run. */
  context?: unknown;
  /** Where this run's output files are written, in place of the instance's. */
  outputDir?: string;
  /** How much this run hands back, in place of the instance's. */
  outputLimit?: OutputLimitSetting;
  /** How much one action may hold in memory during this run, in place of the instance's. */
  maxActionOutputBytes?: number;
}

export class Codemode {
  private _registry: PluginRegistry;
  private _config: CodemodeConfig;
  private readonly _connectionProvider: ConnectionProvider;
  private readonly _memoryConnections?: MemoryConnectionProvider;
  /**
   * One engine per Codemode instance, so its pooled worker survives across
   * `execute()` calls and avoids per-execution thread allocation.
   */
  private _engine: ExecutionEngine | null = null;

  private readonly _onAction: EngineHooks["onAction"];
  private readonly _credentialBroker: EngineHooks["credentialBroker"];
  /** The MCP manager `fromProject` created, which this instance closes. */
  private _mcp?: McpManager;

  private constructor(options: CodemodeOptions) {
    this._registry = new PluginRegistry();
    this._onAction = options.onAction;
    this._credentialBroker = options.credentialBroker;
    if (options.connectionProvider && options.connections) {
      throw new Error("Pass connections or connectionProvider, not both");
    }
    if (options.connectionProvider) {
      this._connectionProvider = options.connectionProvider;
    } else {
      this._memoryConnections = new MemoryConnectionProvider(
        options.connections,
      );
      this._connectionProvider = this._memoryConnections;
    }

    for (const pluginOrFn of options.plugins ?? []) {
      const plugin = resolvePluginExport(pluginOrFn, "unknown");
      this._registry.register(plugin);
    }

    this._config = {
      connections: [],
      timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      memoryLimitBytes:
        options.memoryLimitBytes ?? DEFAULT_CONFIG.memoryLimitBytes,
      ...(options.maxRunsPerWorker !== undefined
        ? { maxRunsPerWorker: options.maxRunsPerWorker }
        : {}),
      ...(options.outputDir !== undefined
        ? { outputDir: options.outputDir }
        : {}),
      ...(options.outputLimit !== undefined
        ? { outputLimit: options.outputLimit }
        : {}),
      ...(options.maxActionOutputBytes !== undefined
        ? { maxActionOutputBytes: options.maxActionOutputBytes }
        : {}),
    };
  }

  private engine(): ExecutionEngine {
    if (!this._engine) {
      this._engine = new ExecutionEngine(this._registry, this._config, {
        onAction: this._onAction,
        connectionProvider: this._connectionProvider,
        credentialBroker: this._credentialBroker,
      });
    }
    return this._engine;
  }

  /**
   * Retire the pooled worker, and end the sessions of the MCP manager
   * `fromProject` created: an open session to a stdio server holds the
   * process open until it is closed or has been idle for five minutes.
   * Idempotent, and the instance stays usable. Callers holding a
   * long-lived Codemode call this on shutdown; an idle pooled worker is
   * unref'd so it will not by itself keep a process alive.
   */
  dispose(): void {
    this._engine?.dispose();
    this._engine = null;
    void this._mcp?.close();
  }

  static create(options: CodemodeOptions = {}): Codemode {
    return new Codemode(options);
  }

  /** Execute JavaScript code in a pooled worker. */
  async execute(
    code: string,
    options?: CodemodeExecuteOptions,
  ): Promise<ExecuteResult> {
    return this.engine().execute(code, options);
  }

  /** Register an additional plugin after creation. */
  addPlugin(
    pluginOrFn: PluginDef | PluginFunction,
    connections?: ConnectionConfig[],
  ): void {
    const plugin = resolvePluginExport(pluginOrFn, "unknown");
    if (connections) {
      if (!this._memoryConnections) {
        throw new Error(
          "Configure connections through the host connection provider",
        );
      }
      this._memoryConnections.add(connections);
    }
    // The engine reads the registry at every run: the next one gets a
    // worker built for the plugins registered by then, and a run in
    // progress keeps the worker it has.
    this._registry.register(plugin);
  }

  /** List all available actions across all plugins. */
  actions(): Array<{
    plugin: string;
    action: string;
    access?: ActionAccess;
    description?: string;
    inputSchema?: InputSchema;
  }> {
    return this._registry.getAllActions().map(({ plugin, action }) => ({
      plugin,
      action: action.name,
      access: action.access,
      description: action.description,
      inputSchema: action.inputSchema,
    }));
  }

  /** List registered plugins. */
  plugins(): Array<{
    name: string;
    version: string;
    description?: string;
    actions: string[];
    connectionConfigSchema?: PluginDef["connectionConfigSchema"];
    /** Where discovery found it; absent on a plugin the host supplied. */
    sourceInfo?: PluginDef["sourceInfo"];
  }> {
    return this._registry.listPlugins().map((p) => ({
      name: p.name,
      version: p.version,
      ...(p.description === undefined ? {} : { description: p.description }),
      actions: p.actions.map((a) => a.name),
      connectionConfigSchema: p.connectionConfigSchema,
      ...(p.sourceInfo ? { sourceInfo: p.sourceInfo } : {}),
    }));
  }

  /**
   * Snapshot of process-local connections. Host-managed providers are not
   * enumerated: their accounts can be caller-scoped and must be listed by the host.
   */
  connections(): ConnectionConfig[] {
    return this._memoryConnections?.list() ?? [];
  }

  /**
   * Load codemode from a project directory.
   *
   * Discovers the `.codemode/` config and registers:
   *   - when the project is trusted, every plugin dropped into
   *     `.codemode/plugins/` (one named like a bundled plugin only when
   *     `config.replaceableBuiltins` lists it) and every plugin listed in
   *     `.codemode/plugins.json`,
   *   - every plugin in `~/.codemode/plugins/`,
   *   - every enabled MCP server (`~/.codemode` and, when trusted, this
   *     project), each as a plugin of its tools, connecting only to one
   *     whose tool list is not cached,
   *   - every configured package (`~/.codemode` and, when trusted, this
   *     project), never installing a missing one,
   *   - and, of the bundled plugins, only the ones a connection puts in
   *     use (`enabledBuiltins(config.connections)`).
   *
   * Gating the builtins keeps `codemode.actions()` scoped to what the
   * project actually configured. Without this, a project with a
   * single connection would still expose every bundled action to an
   * agent, which is both noisy and a privacy problem (the agent sees
   * surface area it has no credentials for).
   *
   * `options.builtinDir` is a test-only hook; production callers
   * should rely on the default path to the bundled plugins.
   *
   * Fully self-contained — does not mutate global state.
   */
  static async fromProject(
    cwd?: string,
    options: {
      builtinDir?: string;
      /**
       * Configured packages to load. Default: a manager over `~/.codemode`
       * and this project, that never installs (missing packages are
       * skipped) and loads project packages only when `trust` allows.
       * `false` loads none.
       */
      packages?: PackageManager | false;
      /**
       * Configured MCP servers to load. Default: a manager over
       * `~/.codemode` and this project, with this project's connections,
       * that `dispose()` closes and that re-registers a server whose tools
       * change. A manager passed here is the caller's: to close, and to
       * re-register from (`onToolsChanged`, then `addPlugin`), so that one
       * manager can serve many instances. `false` loads none.
       */
      mcp?: McpManager | false;
      /**
       * Whether this project's plugin files, packages and MCP servers may load.
       * Default: whether `<userDir>/trust.json` lists it (`codemode trust`).
       */
      trust?: (projectRoot: string) => boolean | Promise<boolean>;
      /** The user's codemode folder. Default: `~/.codemode`. */
      userDir?: string;
    } = {},
  ): Promise<Codemode | null> {
    const configDir = findConfigDir(cwd);
    if (!configDir) return null;

    const config = loadConfigFrom(join(configDir, "config.json"));
    const builtinAllowlist = enabledBuiltins(config.connections);
    const connectionProvider = new FileConnectionProvider(
      join(configDir, "config.json"),
    );
    const userDir = options.userDir ?? userConfigDir();
    const trust =
      options.trust ?? ((root: string) => isProjectTrusted(root, userDir));
    const packages =
      options.packages === false
        ? undefined
        : (options.packages ??
          PackageManager.forCodemodeFolders({
            roots: { user: userDir, project: configDir },
            trust,
            onMissing: "skip",
          }));
    const ownMcp =
      options.mcp === undefined
        ? McpManager.forCodemodeFolders({
            roots: { user: userDir, project: configDir },
            trust,
            connections: connectionProvider,
          })
        : undefined;
    const mcp = options.mcp === false ? undefined : (options.mcp ?? ownMcp);
    const plugins = await discoverPlugins(configDir, {
      builtinAllowlist,
      builtinDir: options.builtinDir,
      replaceableBuiltins: config.replaceableBuiltins,
      trust,
      packages,
      mcp,
      userDir,
    });

    const rl = new Codemode({
      connectionProvider,
      timeoutMs: config.timeoutMs,
      memoryLimitBytes: config.memoryLimitBytes,
      maxRunsPerWorker: config.maxRunsPerWorker,
      outputDir: config.outputDir,
      outputLimit: config.outputLimit,
      maxActionOutputBytes: config.maxActionOutputBytes,
    });

    for (const plugin of plugins) {
      rl._registry.register(plugin);
    }
    if (ownMcp) {
      rl._mcp = ownMcp;
      // A server whose tools changed is registered again from its new
      // snapshot, when it is still the plugin holding its name. The change
      // can arrive in the middle of a run, so the worker is left alone: the
      // next run sees the new actions and gets a worker built for them.
      ownMcp.onToolsChanged(async () => {
        const { plugins: servers } = await ownMcp.load({ connect: false });
        for (const server of servers) {
          const current = rl._registry.getPlugin(server.name);
          if (current?.sourceInfo?.owner !== server.sourceInfo?.owner) continue;
          rl._registry.register(server);
        }
      });
    }

    return rl;
  }
}
