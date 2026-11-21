import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { McpRequestOptions } from "@earendil-works/pi-mcp";
import {
  assertConnectionOwner,
  type ConnectionProvider,
} from "../connections/types.js";
import type {
  ActionContext,
  ConnectionConfig,
  PluginDef,
} from "../plugin/types.js";
import { notifyObserver } from "../utils/observer.js";
import {
  discoverMcpOAuth,
  type McpClientMetadataDocuments,
  type McpCredentials,
  type McpOAuthSetup,
  type McpSignInOverHttp,
  signedIn,
  usesOAuth,
} from "./auth.js";
import {
  FileMcpToolCache,
  type McpServerSnapshot,
  type McpToolCache,
  MemoryMcpToolCache,
} from "./cache.js";
import {
  type McpProblem,
  type McpScope,
  type McpServer,
  type McpSource,
  resolveServers,
} from "./config.js";
import { isMcpServerError, McpServerError } from "./errors.js";
import {
  type McpServerCalls,
  mcpOwner,
  serverPlugin,
  toolResult,
} from "./plugin.js";
import {
  type McpModule,
  type McpServerReport,
  McpSession,
  type McpSessionState,
  type McpTransportFactory,
} from "./session.js";
import { FileMcpStore, type McpStore } from "./store.js";
import {
  INHERITED_ENVIRONMENT,
  resolveClientSecret,
  resolveServer,
} from "./values.js";

export type McpEvent =
  | { type: "state"; server: string; state: McpSessionState; error?: string }
  /** The server's tools, resources or instructions differ from the cached ones. */
  | { type: "changed"; server: string }
  /** A log message the server sent (`notifications/message`). */
  | { type: "log"; server: string; params: unknown }
  | { type: "stderr"; server: string; chunk: string }
  /**
   * A fault no call rejects with: a message from the server that is not
   * JSON-RPC or is too large, a stream that could not be resumed. A call
   * waiting on such a message ends by its timeout.
   */
  | { type: "fault"; server: string; message: string }
  | {
      type: "progress";
      server: string;
      tool: string;
      progress: number;
      total?: number;
      message?: string;
    };

export interface McpManagerOptions {
  store: McpStore;
  /** Where server snapshots are kept between runs. Default: process memory. */
  cache?: McpToolCache;
  /**
   * Resolves a server's connection when the manager connects on its own:
   * in `load()`, `status()`, `refresh()` and `oauth()`. An action call uses
   * the connection the engine resolved for it. Default: no connection, so
   * only servers that need no secret connect outside a call.
   */
  connections?: ConnectionProvider;
  /** Whether the project scope's servers may be read and started. Default: never. */
  trust?: () => boolean | Promise<boolean>;
  /**
   * Builds the transport to a server. Default: pi-mcp's stdio transport,
   * with exactly the environment it is handed, and its Streamable HTTP
   * transport. A host replaces it to start stdio servers in a sandbox, to
   * route HTTP through a proxy, or to refuse a kind of server.
   */
  createTransport?: McpTransportFactory;
  /**
   * What a stdio server inherits of the host's environment, beside its
   * entry's `env`. Default: the few names of `INHERITED_ENVIRONMENT`.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /**
   * What a placeholder names when the server's connection does not hold
   * it. Default: the process environment. A host whose users write entries
   * returns only what they may send to a server.
   */
  variable?: (name: string) => string | undefined;
  /** Sends HTTP servers', discovery and token requests. Default: the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** How codemode names itself to servers. Default: `codemode` and its version. */
  client?: { name: string; version: string };
  /** Tells a person how to sign in to a server. Default: `codemode auth <server>`. */
  signInHint?: (server: string) => string;
  /**
   * What tells two identities of one connection name apart, when a host
   * resolves the same name to different people. Two calls share a session
   * only when this, the server and every value the entry was filled with
   * are the same, and each identity has a tool list of its own in the
   * cache, read for the `context` given to `load()`. Default: sessions are
   * told apart by the connection's name, and every connection of a server
   * shares one tool list.
   */
  identity?: (connection: ConnectionConfig, context: unknown) => string;
  /**
   * The host's Client ID Metadata Documents, to sign in as instead of
   * registering a client with each authorization server. Default: none, so
   * an entry's `oauth.clientRegistration: "cimd"` is refused.
   */
  clientMetadataDocuments?: McpClientMetadataDocuments;
  /**
   * Which servers may be signed in to over http. `loopback`: a server and
   * an authorization server on this machine. `never`: for a host whose
   * machine is not the person's own. Default: `loopback`.
   */
  signInOverHttp?: McpSignInOverHttp;
  /** How long `load()` and `status()` wait for a server. Default: 10 seconds. */
  connectTimeoutMs?: number;
  /**
   * How long `load()` leaves a server alone after it could not be reached,
   * reporting the same problem without trying. A server that asked for
   * sign-in or lacked a value is tried on every load. `status()`,
   * `refresh()` and calls always try. Default: 1 minute.
   */
  retryFailedAfterMs?: number;
  /** A session unused this long is closed. Default: 5 minutes. */
  idleMs?: number;
  /** Open sessions kept at most; the least recently used idle one is closed first. Default: 64. */
  maxSessions?: number;
  onEvent?: (event: McpEvent) => void;
}

export interface McpLoadOptions {
  /**
   * Whether to connect to a server with no usable snapshot. `false` loads
   * such a server with no actions. Default: true.
   */
  connect?: boolean;
  /** Plugin names a server may not take; one that has such a name is not loaded. */
  reservedNames?: Iterable<string>;
  /** Passed to `connections` for the connects this load makes. */
  context?: unknown;
}

export interface McpLoadResult {
  /** One per enabled server, each with `sourceInfo`: origin `mcp`, owner `mcp:<server>`. */
  plugins: PluginDef[];
  problems: McpProblem[];
}

export interface McpServerInfo {
  name: string;
  /** Its name in code. */
  plugin: string;
  scope: McpScope;
  source: string;
  transport: "stdio" | "http";
  enabled: boolean;
  /** The URL, or the command and its arguments. */
  target: string;
  /** Tools in the cached snapshot, when there is one for this entry. */
  cachedTools?: number;
}

export interface McpServerStatus extends McpServerInfo {
  state: McpSessionState | "disabled";
  tools?: number;
  error?: string;
}

const require = createRequire(import.meta.url);

/** pi-mcp's lowest Node. Codemode's own is lower: MCP alone needs this one. */
const MINIMUM_NODE = [22, 19];

function runtimeSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return (
    major > MINIMUM_NODE[0] ||
    (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1])
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Identifies the entry a snapshot was taken through: what selects and starts the server. */
function entryKey(server: McpServer): string {
  const { config } = server;
  return digest(
    "url" in config
      ? [config.url, config.headers ?? {}]
      : [
          config.command,
          config.args ?? [],
          config.env ?? {},
          config.cwd,
          server.base,
        ],
  ).slice(0, 32);
}

function describes(report: McpServerReport): string {
  return JSON.stringify([
    report.tools,
    report.resources,
    report.instructions,
    report.version,
  ]);
}

function targetOf(server: McpServer): string {
  const { config } = server;
  return "url" in config
    ? config.url
    : [config.command, ...(config.args ?? [])].join(" ");
}

/** A server's connection as the manager resolved it. */
interface Resolved {
  credentials: McpCredentials;
  snapshot: ConnectionConfig;
}

/** A session's connection as an action call holds it. */
function credentialsOf(ctx: ActionContext): McpCredentials {
  return {
    read: async () => structuredClone(ctx.connection),
    update: async (change) => {
      await ctx.updateConnection(change);
      return structuredClone(ctx.connection);
    },
  };
}

/**
 * Loads MCP servers as plugins and holds the connections to them. The CLI
 * is one consumer; hosts embed it with their own store, cache, connections,
 * transport and trust. It never prompts, prints or exits, and reads no
 * folder it was not given.
 *
 * The MCP client is imported when the first server is configured, so a
 * project with none never loads it.
 */
export class McpManager {
  private readonly options: McpManagerOptions;
  private readonly cache: McpToolCache;
  private readonly sessions = new Map<string, McpSession>();
  private readonly changeListeners = new Set<(server: string) => unknown>();
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private module: Promise<McpModule> | undefined;

  constructor(options: McpManagerOptions) {
    this.options = options;
    this.cache = options.cache ?? new MemoryMcpToolCache();
  }

  /**
   * A manager over codemode folders laid out as the CLI keeps them: servers
   * under `"mcpServers"` in each folder's `config.json` and in its
   * `mcp.json`, snapshots under its `mcp/`.
   */
  static forCodemodeFolders(
    options: Omit<McpManagerOptions, "store" | "cache" | "trust"> & {
      roots: { user?: string; project?: string };
      /** Whether a project's servers may be read and started. Default: never. */
      trust?: (projectRoot: string) => boolean | Promise<boolean>;
    },
  ): McpManager {
    const { roots, trust, ...rest } = options;
    // One folder serving as both scopes is the user scope only.
    const project = roots.project === roots.user ? undefined : roots.project;
    const folders = { user: roots.user, project };
    return new McpManager({
      ...rest,
      store: new FileMcpStore(folders),
      cache: new FileMcpToolCache(folders),
      trust: async () => !!project && !!trust && (await trust(project)),
    });
  }

  // ── public API ────────────────────────────────────────

  /**
   * Every enabled server as a plugin. A server with a snapshot for its
   * entry is built from it without connecting; any other is connected to
   * once, unless `connect` is false. A server that cannot be reached is a
   * problem and a plugin with no actions.
   */
  async load(options: McpLoadOptions = {}): Promise<McpLoadResult> {
    const { servers, problems } = await this.servers();
    const reserved = new Set(options.reservedNames);
    const plugins = await Promise.all(
      servers
        .filter((server) => server.enabled)
        .map(async (server) => {
          if (reserved.has(server.plugin)) {
            problems.push({
              level: "error",
              code: "name_conflict",
              server: server.name,
              message: `MCP server "${server.name}" (${server.source}) was not loaded: a plugin named "${server.plugin}" is in use. Rename the server, or remove that plugin or its connection.`,
            });
            return undefined;
          }
          let whose: Awaited<ReturnType<McpManager["whose"]>>;
          try {
            whose = await this.whose(server, options.context);
          } catch (error) {
            problems.push(this.problem(server, error));
            return serverPlugin(server, undefined, this.calls(server));
          }
          const { identity } = whose;
          let snapshot = await this.snapshot(server, identity);
          if (!snapshot && options.connect !== false) {
            const failed = await this.recentFailure(server, identity);
            if (failed) problems.push(failed);
            else
              try {
                snapshot = this.snapshotOf(
                  server,
                  await this.report(
                    server,
                    options.context,
                    false,
                    whose.resolved,
                  ),
                );
              } catch (error) {
                const problem = this.problem(server, error);
                problems.push(problem);
                // Only a server that could not be reached: a missing secret,
                // a sign-in or another owner's connection is fixed by the
                // person and works on the next run.
                if (isMcpServerError(error) && error.code === "connect_failed")
                  await this.rememberFailure(server, identity, problem);
              }
          }
          return serverPlugin(server, snapshot, this.calls(server));
        }),
    );
    return { plugins: plugins.filter((plugin) => !!plugin), problems };
  }

  /** Every configured server, without connecting to any. */
  async list(options: { context?: unknown } = {}): Promise<McpServerInfo[]> {
    const servers = await this.selected();
    return Promise.all(
      servers.map(async (server) =>
        this.info(server, (await this.whoseIfKnown(server, options)).identity),
      ),
    );
  }

  /** Connect to each enabled server, or the one named, and say how it went. */
  async status(
    name?: string,
    options: { context?: unknown } = {},
  ): Promise<McpServerStatus[]> {
    const servers = await this.selected(name);
    return Promise.all(
      servers.map(async (server): Promise<McpServerStatus> => {
        const whose = await this.whoseIfKnown(server, options);
        const info = await this.info(server, whose.identity);
        if (!server.enabled) return { ...info, state: "disabled" };
        try {
          const report = await this.report(
            server,
            options.context,
            false,
            whose.resolved,
          );
          return { ...info, state: "connected", tools: report.tools.length };
        } catch (error) {
          const needsSignIn =
            isMcpServerError(error) && error.code === "reconnect_required";
          return {
            ...info,
            state: needsSignIn ? "needs_sign_in" : "failed",
            error: (error as Error).message,
          };
        }
      }),
    );
  }

  /**
   * Read tool lists again from each enabled server, or the one named, and
   * replace their snapshots. Answers the servers that changed.
   */
  async refresh(
    name?: string,
    options: { context?: unknown } = {},
  ): Promise<string[]> {
    const changed: string[] = [];
    const listener = (server: string) => changed.push(server);
    this.changeListeners.add(listener);
    try {
      for (const server of await this.selected(name))
        if (server.enabled) await this.report(server, options.context, true);
    } finally {
      this.changeListeners.delete(listener);
    }
    return changed;
  }

  /** Record a server. A name the scope already defines is refused, not replaced. */
  async add(
    name: string,
    entry: Record<string, unknown>,
    options: { scope?: McpScope } = {},
  ): Promise<McpServerInfo> {
    const scope = options.scope ?? "user";
    if (scope === "project" && !(await this.trusted()))
      throw new McpServerError(
        "untrusted",
        "The project is not trusted, so its MCP servers would not load. Trust it first.",
      );
    const mcp = await this.mcp();
    const sources = await this.options.store.read(scope);
    const defined = sources.find((source) =>
      Object.hasOwn(source.servers, name),
    );
    if (defined)
      throw new McpServerError(
        "name_conflict",
        `MCP server "${name}" is already defined in ${defined.source}. Remove it first.`,
        { server: name },
      );
    // Resolved after the scope's own servers, so a name one of them has in
    // code is this entry's problem, not theirs.
    const added: McpSource = {
      source: "the new entry",
      servers: { [name]: entry },
    };
    const problem = resolveServers(
      { [scope]: [...sources, added] },
      { ...this.check(mcp), isOverride: () => false },
    ).problems.find((found) => found.server === name);
    if (problem)
      throw new McpServerError(problem.code, problem.message, { server: name });
    await this.options.store.write(scope, name, entry);
    const recorded = (await this.servers()).servers.find(
      (server) => server.name === name,
    );
    if (!recorded)
      throw new McpServerError("not_found", `MCP server "${name}" not found`);
    return this.info(recorded, undefined);
  }

  /** Forget a server: its entry, its snapshot and its open sessions. Answers whether it was defined. */
  async remove(
    name: string,
    options: { scope?: McpScope } = {},
  ): Promise<boolean> {
    const scope = options.scope ?? "user";
    const existed = await this.options.store.write(scope, name, undefined);
    await this.cache.remove(scope, name);
    await this.closeSessions((session) => session.server.name === name);
    return existed;
  }

  /**
   * How to sign in to an HTTP server: its endpoints as an OAuth2 definition
   * and the client to sign in as. That is the one the entry names, else the
   * host's metadata document, else one registered with `redirectUri`. Run
   * the consent with the setup's own `redirectUri` and codemode's OAuth
   * runtime
   * (`runOAuth`, or `buildOAuth2AuthorizationUrl` and `exchangeOAuth2Code`)
   * and store `mcpOAuthConnection(setup, tokens)` in the server's connection.
   */
  async oauth(
    name: string,
    options: { redirectUri: string; context?: unknown; signal?: AbortSignal },
  ): Promise<McpOAuthSetup> {
    const [server] = await this.selected(name);
    const { snapshot } = await this.credentials(server, options.context);
    const mcp = await this.mcp();
    const { parseWwwAuthenticate } = await import(
      "@earendil-works/pi-mcp/oauth"
    );
    let challenge: ReturnType<typeof parseWwwAuthenticate> | undefined;
    if (usesOAuth(server)) {
      // An unauthenticated connect, for the server's challenge: where its
      // resource metadata is and the scope it asks for.
      options.signal?.throwIfAborted();
      const client = new mcp.McpClient({
        ...this.clientInfo(),
        requestTimeoutMs: this.connectTimeoutMs,
      });
      const stop = () => void client.close().catch(() => undefined);
      options.signal?.addEventListener("abort", stop, { once: true });
      try {
        await client.connect(
          await this.createTransport(mcp)({
            ...this.resolve(server, snapshot),
            server: server.name,
          }),
        );
      } catch (error) {
        if (error instanceof mcp.McpAuthRequiredError)
          challenge = parseWwwAuthenticate(error.wwwAuthenticate);
      } finally {
        options.signal?.removeEventListener("abort", stop);
        await client.close().catch(() => undefined);
      }
      options.signal?.throwIfAborted();
    }
    return discoverMcpOAuth({
      server,
      redirectUri: options.redirectUri,
      clientName: this.clientInfo().name,
      challenge,
      clientSecret: resolveClientSecret(server, {
        connection: snapshot.config,
        variable: this.variable,
      }),
      clientMetadataDocuments: this.options.clientMetadataDocuments,
      signInOverHttp: this.options.signInOverHttp,
      fetch: this.options.fetch,
      signal: options.signal,
    });
  }

  /** Called with a server's name when what it offers differs from its snapshot. Answers how to stop. */
  onToolsChanged(listener: (server: string) => unknown): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * End every session, and with each a stdio server's process: stdin is
   * closed, then the process group is terminated. The manager stays
   * usable; the next call opens a session again.
   */
  async close(): Promise<void> {
    await this.closeSessions(() => true);
  }

  // ── servers ───────────────────────────────────────────

  private mcp(): Promise<McpModule> {
    if (!runtimeSupported())
      return Promise.reject(
        new McpServerError(
          "unsupported_runtime",
          `MCP servers need Node ${MINIMUM_NODE.join(".")} or later; this is ${process.versions.node}.`,
        ),
      );
    this.module ??= import("@earendil-works/pi-mcp");
    return this.module;
  }

  /**
   * How entries are checked: pi-mcp's rules, with `cimd` allowed where the
   * host's documents list the entry's callback.
   */
  private check(mcp: McpModule): Parameters<typeof resolveServers>[1] {
    const documents = this.options.clientMetadataDocuments;
    return {
      validate: (name, raw) =>
        mcp.validateMcpServerConfig(
          name,
          raw,
          documents
            ? {
                checkMetadataDocumentCallback: (callbackUrl) =>
                  callbackUrl === undefined ||
                  documents.listsRedirectUrl(callbackUrl)
                    ? undefined
                    : 'oauth.clientRegistration "cimd" needs an oauth.callbackUrl that the client metadata documents list',
              }
            : {},
        ),
      isOverride: mcp.isMcpServerOverride,
    };
  }

  private async trusted(): Promise<boolean> {
    return (await this.options.trust?.()) === true;
  }

  /** The configured servers. The project's are read only when it is trusted. */
  private async servers(): Promise<{
    servers: McpServer[];
    problems: McpProblem[];
  }> {
    const { store } = this.options;
    const user = await store.read("user");
    const project = await store.read("project");
    const defined = (sources: McpSource[]) =>
      sources.reduce(
        (count, source) => count + Object.keys(source.servers).length,
        0,
      );
    const problems: McpProblem[] = [];
    const trusted = defined(project) > 0 && (await this.trusted());
    if (defined(project) > 0 && !trusted)
      problems.push({
        level: "warning",
        code: "untrusted",
        message: `${defined(project)} MCP server(s) in ${project
          .filter((source) => Object.keys(source.servers).length)
          .map((source) => source.source)
          .join(
            " and ",
          )} were not loaded: the project is not trusted. Run \`codemode trust\` there to load them.`,
      });
    const scopes = { user, ...(trusted ? { project } : {}) };
    if (!defined(user) && !trusted) {
      // Nothing to validate: report unreadable places without loading the client.
      const resolved = resolveServers(scopes, {
        validate: () => ({ kind: "invalid", error: "" }),
        isOverride: () => false,
      });
      return { servers: [], problems: [...problems, ...resolved.problems] };
    }
    let mcp: McpModule;
    try {
      mcp = await this.mcp();
    } catch (error) {
      if (!isMcpServerError(error)) throw error;
      return {
        servers: [],
        problems: [
          ...problems,
          { level: "error", code: error.code, message: error.message },
        ],
      };
    }
    const resolved = resolveServers(scopes, this.check(mcp));
    return {
      servers: resolved.servers,
      problems: [...problems, ...resolved.problems],
    };
  }

  /** Every server, or the one named. */
  private async selected(name?: string): Promise<McpServer[]> {
    const { servers, problems } = await this.servers();
    // A runtime that cannot load the client has no servers to select: say
    // why, rather than answer that none is configured.
    const unsupported = problems.find(
      (found) => found.code === "unsupported_runtime",
    );
    if (unsupported)
      throw new McpServerError(unsupported.code, unsupported.message);
    if (name === undefined) return servers;
    const server = servers.find((found) => found.name === name);
    if (server) return [server];
    const problem = problems.find((found) => found.server === name);
    throw new McpServerError(
      problem?.code ?? "not_found",
      problem?.message ?? `No MCP server named "${name}" is configured.`,
      { server: name },
    );
  }

  private async info(
    server: McpServer,
    identity: string | undefined,
  ): Promise<McpServerInfo> {
    const snapshot = await this.snapshot(server, identity);
    return {
      name: server.name,
      plugin: server.plugin,
      scope: server.scope,
      source: server.source,
      transport: server.kind,
      enabled: server.enabled,
      target: targetOf(server),
      ...(snapshot ? { cachedTools: snapshot.tools.length } : {}),
    };
  }

  private problem(server: McpServer, error: unknown): McpProblem {
    return {
      level: "error",
      code: isMcpServerError(error) ? error.code : "connect_failed",
      server: server.name,
      message: isMcpServerError(error)
        ? error.message
        : `MCP server "${server.name}" failed: ${(error as Error).message}`,
    };
  }

  // ── snapshots ─────────────────────────────────────────

  /**
   * Whose tool list a server's is, before any session exists: the host's
   * `identity` of the server's connection, which is resolved here and
   * handed on. Without `identity` every connection shares one list, and
   * nothing is resolved.
   */
  private async whose(
    server: McpServer,
    context: unknown,
  ): Promise<{ identity?: string; resolved?: Resolved }> {
    if (!this.options.identity) return {};
    const resolved = await this.credentials(server, context);
    return {
      identity: this.options.identity(resolved.snapshot, context),
      resolved,
    };
  }

  /** `whose`, for a caller that reports on a server whose connection cannot be resolved. */
  private whoseIfKnown(
    server: McpServer,
    options: { context?: unknown },
  ): ReturnType<McpManager["whose"]> {
    return this.whose(server, options.context).catch(() => ({}));
  }

  /** What the cache holds for this entry: a snapshot, or the record of a failed connect. */
  private async cached(
    server: McpServer,
    identity: string | undefined,
  ): Promise<McpServerSnapshot | undefined> {
    const snapshot = await this.cache.read(server.scope, server.name, identity);
    return snapshot?.key === entryKey(server) ? snapshot : undefined;
  }

  /** The cached snapshot taken through this entry, if any. */
  private async snapshot(
    server: McpServer,
    identity: string | undefined,
  ): Promise<McpServerSnapshot | undefined> {
    const snapshot = await this.cached(server, identity);
    return snapshot?.failure ? undefined : snapshot;
  }

  /** The problem of a connect that failed too recently to try again. */
  private async recentFailure(
    server: McpServer,
    identity: string | undefined,
  ): Promise<McpProblem | undefined> {
    const snapshot = await this.cached(server, identity);
    const retryAfter = this.options.retryFailedAfterMs ?? 60_000;
    if (!snapshot?.failure || Date.now() - snapshot.savedAt >= retryAfter)
      return undefined;
    return {
      level: "error",
      server: server.name,
      code: snapshot.failure.code,
      message: `${snapshot.failure.message} (Not tried again for ${Math.ceil(
        (snapshot.savedAt + retryAfter - Date.now()) / 1000,
      )} s.)`,
    };
  }

  private async rememberFailure(
    server: McpServer,
    identity: string | undefined,
    problem: McpProblem,
  ): Promise<void> {
    await this.cache
      .write(
        server.scope,
        server.name,
        {
          key: entryKey(server),
          tools: [],
          resources: false,
          savedAt: Date.now(),
          failure: { code: problem.code, message: problem.message },
        },
        identity,
      )
      .catch(() => undefined);
  }

  private snapshotOf(
    server: McpServer,
    report: McpServerReport,
  ): McpServerSnapshot {
    return { ...report, key: entryKey(server), savedAt: Date.now() };
  }

  /** Replace a server's snapshot with what it reports now, and say so when it differs. */
  private async record(
    server: McpServer,
    identity: string | undefined,
    report: McpServerReport,
  ): Promise<void> {
    let previous: McpServerSnapshot | undefined;
    try {
      previous = await this.snapshot(server, identity);
      await this.cache.write(
        server.scope,
        server.name,
        this.snapshotOf(server, report),
        identity,
      );
    } catch {
      // A cache that cannot be written costs a connect next time, not this call.
      return;
    }
    if (!previous || describes(previous) === describes(report)) return;
    this.emit({ type: "changed", server: server.name });
    // Each is called at once; what it throws or rejects with is its own.
    for (const listener of this.changeListeners)
      notifyObserver(async (name: string) => {
        await listener(name);
      }, server.name);
  }

  /**
   * What a server offers, from a connection the manager makes itself:
   * `resolved`, else the one it resolves now. Connecting reads the tool
   * list; `again` reads it once more on a session that was already
   * connected.
   */
  private async report(
    server: McpServer,
    context: unknown,
    again = false,
    resolved?: Resolved,
  ): Promise<McpServerReport> {
    const { credentials, snapshot } =
      resolved ?? (await this.credentials(server, context));
    const session = await this.session(server, credentials, snapshot, context);
    const connected = session.state === "connected";
    await session.connect();
    if (again && connected) return session.refresh();
    if (!session.report)
      throw new McpServerError(
        "connect_failed",
        `MCP server "${server.name}" reported no tools`,
        { server: server.name },
      );
    return session.report;
  }

  // ── sessions ──────────────────────────────────────────

  private readonly variable = (name: string): string | undefined =>
    this.options.variable ? this.options.variable(name) : process.env[name];

  private get connectTimeoutMs(): number {
    return this.options.connectTimeoutMs ?? 10_000;
  }

  private clientInfo(): { name: string; version: string } {
    return (
      this.options.client ?? {
        name: "codemode",
        version: require("../../package.json").version,
      }
    );
  }

  private resolve(server: McpServer, connection: ConnectionConfig) {
    return resolveServer(server, {
      connection: connection.config,
      variable: this.variable,
      inherited:
        this.options.environment ??
        Object.fromEntries(
          INHERITED_ENVIRONMENT.map((name) => [name, process.env[name]]),
        ),
    });
  }

  private createTransport(mcp: McpModule): McpTransportFactory {
    return (
      this.options.createTransport ??
      ((request) =>
        request.kind === "http"
          ? new mcp.StreamableHttpTransport({
              url: request.url,
              headers: request.headers,
              authProvider: request.authProvider,
              fetch: this.options.fetch,
            })
          : new mcp.StdioTransport({
              command: request.command,
              args: request.args,
              cwd: request.cwd,
              env: request.env,
              inheritEnv: false,
              stderr: "pipe",
              onStderr: request.onStderr,
            }))
    );
  }

  /** The connection the manager resolves for a server when no action call supplies one. */
  private async credentials(
    server: McpServer,
    context: unknown,
  ): Promise<Resolved> {
    const owner = mcpOwner(server.name);
    const none: ConnectionConfig = {
      name: server.plugin,
      plugin: server.plugin,
      config: {},
      owner,
    };
    if (!this.options.connections)
      return {
        snapshot: none,
        credentials: {
          read: async () => structuredClone(none),
          update: async () => {
            throw new Error(`MCP server "${server.name}" has no connection`);
          },
        },
      };
    const handle = await this.options.connections.resolve({
      plugin: server.plugin,
      owner,
      context,
    });
    const snapshot = await handle.read();
    assertConnectionOwner(snapshot, {
      name: server.plugin,
      sourceInfo: { path: "", source: "", origin: "mcp", owner },
    });
    return { snapshot, credentials: handle };
  }

  /**
   * The session for one server and one identity, opened when there is none.
   * Its key holds everything the entry was filled with, so a changed secret
   * or another person's connection is another session.
   */
  private async session(
    server: McpServer,
    credentials: McpCredentials,
    connection: ConnectionConfig,
    context: unknown,
  ): Promise<McpSession> {
    const resolved = this.resolve(server, connection);
    // Awaited before the lookup: from here to `sessions.set` nothing yields,
    // so two calls made together for one identity open one session.
    const mcp = await this.mcp();
    const identity = this.options.identity?.(connection, context);
    const key = digest([
      server.scope,
      server.name,
      entryKey(server),
      identity ?? connection.name,
      resolved,
      signedIn(connection.config),
    ]);
    let session = this.sessions.get(key);
    if (session && session.state === "closed") session = undefined;
    if (!session) {
      const created = new McpSession({
        mcp,
        server,
        resolved,
        credentials,
        createTransport: this.createTransport(mcp),
        client: this.clientInfo(),
        signInHint:
          this.options.signInHint?.(server.name) ??
          `Run \`codemode auth ${server.name}\`.`,
        connectTimeoutMs: this.connectTimeoutMs,
        fetch: this.options.fetch,
        onReport: (report) => this.record(server, identity, report),
        onState: (changed) =>
          this.emit({
            type: "state",
            server: server.name,
            state: changed.state,
            ...(changed.error === undefined ? {} : { error: changed.error }),
          }),
        onLog: (params) =>
          this.emit({ type: "log", server: server.name, params }),
        onStderr: (chunk) =>
          this.emit({ type: "stderr", server: server.name, chunk }),
        onFault: (error) =>
          this.emit({
            type: "fault",
            server: server.name,
            message: error.message,
          }),
      });
      this.sessions.set(key, created);
      session = created;
      this.watchIdle();
      void this.evict();
    }
    session.use(credentials);
    return session;
  }

  /** What a server's actions call: each runs on the session of the call's own connection. */
  private calls(server: McpServer): McpServerCalls {
    const run = async <T>(
      ctx: ActionContext,
      request: (session: McpSession, options: McpRequestOptions) => Promise<T>,
      tool?: string,
    ): Promise<T> => {
      const session = await this.session(
        server,
        credentialsOf(ctx),
        ctx.connection,
        ctx.context,
      );
      return request(session, {
        signal: ctx.signal,
        ...(tool === undefined
          ? {}
          : {
              // Asking for progress is what makes a server send it, and each
              // notification restarts the request's timeout.
              onProgress: (progress) =>
                this.emit({
                  type: "progress",
                  server: server.name,
                  tool,
                  progress: progress.progress,
                  ...(progress.total === undefined
                    ? {}
                    : { total: progress.total }),
                  ...(progress.message === undefined
                    ? {}
                    : { message: progress.message }),
                }),
            }),
      });
    };
    const withoutMeta = <T extends { _meta?: unknown }>(result: T) => {
      const { _meta, ...rest } = result;
      return rest;
    };
    const cursor = (input: unknown) => (input as { cursor?: string }).cursor;
    return {
      tool: async (tool, input, ctx) =>
        toolResult(
          server.name,
          tool,
          await run(
            ctx,
            (session, options) =>
              session.callTool(tool, input as Record<string, unknown>, options),
            tool,
          ),
        ),
      resources: async (input, ctx) =>
        withoutMeta(
          await run(ctx, (session, options) =>
            session.resourcesPage(cursor(input), options),
          ),
        ),
      resourceTemplates: async (input, ctx) =>
        withoutMeta(
          await run(ctx, (session, options) =>
            session.resourceTemplatesPage(cursor(input), options),
          ),
        ),
      readResource: async (input, ctx) =>
        withoutMeta(
          await run(ctx, (session, options) =>
            session.readResource((input as { uri: string }).uri, options),
          ),
        ),
    };
  }

  private emit(event: McpEvent): void {
    notifyObserver(this.options.onEvent, event);
  }

  private async closeSessions(
    matches: (session: McpSession) => boolean,
  ): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, session] of this.sessions) {
      if (!matches(session)) continue;
      this.sessions.delete(key);
      closing.push(session.close());
    }
    if (!this.sessions.size && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    await Promise.all(closing);
  }

  /** Close sessions no call has used for `idleMs`. The timer never holds the process open. */
  private watchIdle(): void {
    if (this.idleTimer) return;
    const idleMs = this.options.idleMs ?? 5 * 60_000;
    this.idleTimer = setInterval(
      () => {
        const before = Date.now() - idleMs;
        void this.closeSessions(
          (session) => session.active === 0 && session.lastUsed < before,
        );
      },
      Math.max(1_000, Math.min(idleMs / 2, 30_000)),
    );
    this.idleTimer.unref?.();
  }

  /** Past `maxSessions`, close the idle sessions used longest ago. */
  private async evict(): Promise<void> {
    const excess = this.sessions.size - (this.options.maxSessions ?? 64);
    if (excess <= 0) return;
    const idle = [...this.sessions.values()]
      .filter((session) => session.active === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, excess);
    await this.closeSessions((session) => idle.includes(session));
  }
}
