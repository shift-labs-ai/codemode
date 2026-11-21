import { setTimeout as sleep } from "node:timers/promises";
import type {
  AuthProvider,
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  McpClient,
  McpRequestOptions,
  McpTransport,
  ReadResourceResult,
  Tool,
} from "@earendil-works/pi-mcp";
import {
  createMcpAuthProvider,
  type McpCredentials,
  signInRequired,
  usesOAuth,
} from "./auth.js";
import type { McpServer } from "./config.js";
import { isMcpServerError, McpServerError } from "./errors.js";
import type { McpResolvedServer } from "./values.js";

/**
 * `disconnected`: the connection dropped (a stdio server exited, say); the
 * next call reconnects. `needs_sign_in`: the server refused the credential.
 */
export type McpSessionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "needs_sign_in"
  | "failed"
  | "closed";

/** What a transport is built from: one server's entry, filled for one identity. */
export type McpTransportRequest = McpResolvedServer & {
  /** The server's configuration key. */
  server: string;
  /** Supplies and renews the bearer of an HTTP server signed in to with OAuth. */
  authProvider?: AuthProvider;
  /** Receives a stdio server's stderr as it arrives. */
  onStderr?: (chunk: string) => void;
};

export type McpTransportFactory = (
  request: McpTransportRequest,
) => McpTransport | Promise<McpTransport>;

/** What a connected server reported, for the manager to cache and compare. */
export interface McpServerReport {
  tools: Tool[];
  resources: boolean;
  instructions?: string;
  version?: string;
}

export type McpModule = typeof import("@earendil-works/pi-mcp");

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed transiently. */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One connection to one server for one identity. It connects on first use,
 * reconnects when a call finds the connection gone, and never repeats a
 * tool call that may have run.
 */
export class McpSession {
  readonly server: McpServer;
  state: McpSessionState = "idle";
  /** Why the last connect failed. */
  error: string | undefined;
  report: McpServerReport | undefined;
  /** When a call last used the session, for closing idle ones. */
  lastUsed = Date.now();
  /** Calls in flight; a session with any is not idle. */
  active = 0;
  private client: McpClient | undefined;
  /** Clients a call set aside after the server forgot their session, still to be closed. */
  private readonly detached = new Set<McpClient>();
  private opening: Promise<McpClient> | undefined;
  /** Aborted by `close()`; cancels a connect in progress, including its waits. */
  private readonly shutdown = new AbortController();
  private stderrTail = "";
  private credentials: McpCredentials;
  private readonly authProvider: AuthProvider | undefined;

  constructor(
    private readonly options: {
      mcp: McpModule;
      server: McpServer;
      resolved: McpResolvedServer;
      credentials: McpCredentials;
      createTransport: McpTransportFactory;
      client: { name: string; version: string };
      signInHint: string;
      connectTimeoutMs: number;
      fetch?: typeof globalThis.fetch;
      /** Awaited after every connect and tool-list change, with what the server reports. */
      onReport: (report: McpServerReport) => Promise<void>;
      onState: (session: McpSession) => void;
      /** A log message the server sent (`notifications/message`). */
      onLog: (params: unknown) => void;
      onStderr: (chunk: string) => void;
      /**
       * A fault no request answers for: a message the server sent that is
       * not JSON-RPC or is too large, a stream that could not be resumed.
       */
      onFault: (error: Error) => void;
    },
  ) {
    this.server = options.server;
    this.credentials = options.credentials;
    this.authProvider = usesOAuth(options.server)
      ? createMcpAuthProvider({
          server: options.server,
          credentials: () => this.credentials,
          signInHint: options.signInHint,
          fetch: options.fetch,
        })
      : undefined;
  }

  private get closed(): boolean {
    return this.shutdown.signal.aborted;
  }

  private get timeoutMs(): number {
    return (this.server.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  /** The connection later requests read their token through: the latest caller's. */
  use(credentials: McpCredentials): void {
    this.credentials = credentials;
    this.lastUsed = Date.now();
  }

  private setState(state: McpSessionState, error?: string): void {
    this.state = state;
    this.error = error;
    this.options.onState(this);
  }

  private shutDown(): McpServerError {
    return new McpServerError(
      "closed",
      `MCP server "${this.server.name}" is shut down`,
      { server: this.server.name },
    );
  }

  /** The connected client, connecting first when there is none. */
  connect(): Promise<McpClient> {
    if (this.closed) return Promise.reject(this.shutDown());
    if (this.client?.connectionState === "connected")
      return Promise.resolve(this.client);
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<CallToolResult> {
    return this.request((client) => client.callTool(name, args, options));
  }

  readResource(
    uri: string,
    options: McpRequestOptions,
  ): Promise<ReadResourceResult> {
    return this.request((client) => client.readResource(uri, options), true);
  }

  resourcesPage(
    cursor: string | undefined,
    options: McpRequestOptions,
  ): Promise<ListResourcesResult> {
    return this.request(
      (client) => client.listResourcesPage(cursor, options),
      true,
    );
  }

  /** A server that does not implement `resources/templates/list` has no templates. */
  resourceTemplatesPage(
    cursor: string | undefined,
    options: McpRequestOptions,
  ): Promise<ListResourceTemplatesResult> {
    const { McpError, JSON_RPC_ERROR_CODES } = this.options.mcp;
    return this.request(async (client) => {
      try {
        return await client.listResourceTemplatesPage(cursor, options);
      } catch (error) {
        if (
          error instanceof McpError &&
          error.code === JSON_RPC_ERROR_CODES.methodNotFound
        )
          return { resourceTemplates: [] };
        throw error;
      }
    }, true);
  }

  /** Read the tool list again and report it. */
  async refresh(): Promise<McpServerReport> {
    const client = await this.connect();
    return this.describe(client);
  }

  /**
   * Run a request, reconnecting when needed. `readOnly` requests are tried
   * once more after a transient HTTP error; tool calls are not, since they
   * may have run.
   */
  private async request<T>(
    run: (client: McpClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const { McpHttpError, McpSessionExpiredError } = this.options.mcp;
    this.active++;
    try {
      for (let attempt = 1; ; attempt++) {
        const client = await this.connect();
        try {
          return await run(client);
        } catch (error) {
          if (
            readOnly &&
            attempt === 1 &&
            error instanceof McpHttpError &&
            this.transient(error)
          ) {
            await sleep(CONNECT_RETRY_DELAYS_MS[0]);
            continue;
          }
          if (error instanceof McpSessionExpiredError && attempt === 1) {
            // The server no longer knows the session (a restart, a deploy), so
            // it did not run the request. Try once on a new session. The old
            // client is set aside, not closed: closing would fail its other
            // calls in flight, which get the same answer and retry this way.
            if (this.client === client) {
              this.client = undefined;
              this.detached.add(client);
            }
            continue;
          }
          const refused = this.refusal(error);
          if (!refused) throw this.unanswered(error) ?? error;
          await this.drop(client);
          this.setState("needs_sign_in");
          throw refused;
        }
      }
    } finally {
      this.active--;
      this.lastUsed = Date.now();
    }
  }

  /** Network failures and overloaded or restarting servers, worth another attempt. */
  private transient(error: unknown): boolean {
    const { McpHttpError } = this.options.mcp;
    if (error instanceof McpHttpError)
      return (
        error.status === 408 ||
        error.status === 429 ||
        (error.status >= 500 && error.status !== 501)
      );
    return error instanceof TypeError;
  }

  /** The sign-in error a credential refusal becomes, or undefined for any other failure. */
  private refusal(error: unknown): McpServerError | undefined {
    if (isMcpServerError(error) && error.code === "reconnect_required")
      return error;
    if (!(error instanceof this.options.mcp.McpAuthRequiredError))
      return undefined;
    return this.authProvider
      ? signInRequired(this.server.name, this.options.signInHint)
      : new McpServerError(
          "reconnect_required",
          `MCP server "${this.server.name}" refused the credentials its entry sends (HTTP 401).`,
          { server: this.server.name },
        );
  }

  /**
   * A request the server never answered, as an error that names the server
   * and, for one that dropped the connection, what it last printed.
   * Undefined for any other failure.
   */
  private unanswered(error: unknown): McpServerError | undefined {
    const { McpConnectionClosedError, McpTimeoutError } = this.options.mcp;
    const name = this.server.name;
    if (error instanceof McpTimeoutError)
      return new McpServerError(
        "timed_out",
        `MCP server "${name}" did not answer within ${error.timeoutMs / 1000} s`,
        { server: name, cause: error },
      );
    if (!(error instanceof McpConnectionClosedError)) return undefined;
    if (this.closed) return this.shutDown();
    const tail = this.stderrTail.trim();
    return new McpServerError(
      "closed",
      `MCP server "${name}" closed the connection before it answered${tail ? `:\n${tail}` : ""}`,
      { server: name, cause: error },
    );
  }

  private async drop(client: McpClient): Promise<void> {
    if (this.client === client) this.client = undefined;
    await client.close().catch(() => undefined);
  }

  private async open(): Promise<McpClient> {
    this.setState("connecting");
    const retries =
      this.options.resolved.kind === "http" ? CONNECT_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      this.stderrTail = "";
      try {
        return await this.connectOnce();
      } catch (error) {
        const delay = retries[attempt];
        if (this.closed || delay === undefined || !this.transient(error))
          throw this.connectFailed(error);
        await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(
          () => undefined,
        );
        if (this.closed) throw this.connectFailed(error);
      }
    }
  }

  private async connectOnce(): Promise<McpClient> {
    const { options } = this;
    const client = new options.mcp.McpClient({
      name: options.client.name,
      version: options.client.version,
      requestTimeoutMs: this.timeoutMs,
    });
    client.onNotification("notifications/message", (params) =>
      options.onLog(params),
    );
    // The client drops an error nobody listens for.
    client.onError((error) => options.onFault(error));
    // Closing the client fails its pending requests and closes the transport.
    // Kept once: a second `close()` returns before the first has finished.
    let closing: Promise<void> | undefined;
    const closeClient = () => {
      closing ??= client.close().catch(() => undefined);
      return closing;
    };
    this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void closeClient();
    }, options.connectTimeoutMs);
    try {
      const transport = await options.createTransport({
        ...options.resolved,
        server: this.server.name,
        ...(this.authProvider ? { authProvider: this.authProvider } : {}),
        onStderr: (chunk) => {
          this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
          options.onStderr(chunk);
        },
      });
      await client.connect(transport);
      client.onNotification("notifications/tools/list_changed", () => {
        void this.describe(client).catch(() => undefined);
      });
      client.onClose(() => {
        if (this.client !== client) return;
        this.client = undefined;
        if (!this.closed) this.setState("disconnected");
      });
      await this.describe(client);
      if (this.closed) throw new Error("shut down while connecting");
      if (client.connectionState !== "connected")
        throw new Error("connection closed during setup");
      this.client = client;
      this.setState("connected");
      return client;
    } catch (error) {
      await closeClient();
      throw timedOut
        ? new Error(
            `no answer within ${Math.round(options.connectTimeoutMs / 1000)} s`,
          )
        : error;
    } finally {
      clearTimeout(timer);
      this.shutdown.signal.removeEventListener("abort", closeClient);
    }
  }

  /** What the server offers now. A server without the tools capability does not answer `tools/list`. */
  private async describe(client: McpClient): Promise<McpServerReport> {
    const tools = client.serverCapabilities?.tools
      ? await client.listTools()
      : [];
    const instructions = client.instructions?.trim();
    const report: McpServerReport = {
      tools,
      resources: client.serverCapabilities?.resources !== undefined,
      ...(instructions ? { instructions } : {}),
      ...(client.serverInfo?.version
        ? { version: client.serverInfo.version }
        : {}),
    };
    this.report = report;
    await this.options.onReport(report);
    return report;
  }

  private connectFailed(error: unknown): Error {
    const name = this.server.name;
    if (this.closed) {
      this.setState("closed");
      return this.shutDown();
    }
    const refused = this.refusal(error);
    if (refused) {
      this.setState("needs_sign_in");
      return refused;
    }
    const tail = this.stderrTail.trim();
    const reason = tail
      ? `${errorMessage(error)}\n${tail}`
      : errorMessage(error);
    this.setState("failed", reason);
    return new McpServerError(
      "connect_failed",
      `MCP server "${name}" failed to connect: ${reason}`,
      { server: name, cause: error },
    );
  }

  /** End the connection, and with it a stdio server's process. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.shutdown.abort();
    await this.opening?.catch(() => undefined);
    const clients = [...this.detached, ...(this.client ? [this.client] : [])];
    this.client = undefined;
    this.detached.clear();
    await Promise.all(
      clients.map((client) => client.close().catch(() => undefined)),
    );
    this.setState("closed");
  }
}
