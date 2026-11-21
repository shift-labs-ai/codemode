/**
 * MCP servers for tests. One set of handlers answers over three wires: an
 * in-memory transport pair, a fake `fetch` speaking Streamable HTTP, and
 * (in `mcp-stdio-server.mjs`) a real process on stdio.
 */

import type {
  CallToolResult,
  JsonRpcMessage,
  McpTransport,
  Tool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

/** `${name}` as an entry writes it, built so no linter reads it as a template slip. */
export const placeholder = (name: string) => ["$", "{", name, "}"].join("");

export interface FakeServerOptions {
  tools?: Tool[];
  instructions?: string;
  version?: string;
  /** Offer resources: what `resources/list` and `resources/read` answer from. */
  resources?: Array<{ uri: string; name: string; text: string }>;
  /** Answers `tools/call`. A promise that never settles holds the call open. */
  call?: (
    name: string,
    args: Record<string, unknown>,
  ) => CallToolResult | Promise<CallToolResult>;
}

export interface FakeServer {
  options: FakeServerOptions;
  /** Every request and notification received, in order. */
  received: Array<{ method: string; params?: unknown }>;
  /** Connections opened so far. */
  connections: number;
  /** A client transport to a new connection of this server. */
  transport(): McpTransport;
  /** Send a notification to every open connection. */
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  /** Answer one message; undefined for a notification. */
  handle(message: JsonRpcMessage): Promise<JsonRpcMessage | undefined>;
}

export function fakeServer(options: FakeServerOptions = {}): FakeServer {
  const open = new Set<McpTransport>();
  const server: FakeServer = {
    options,
    received: [],
    connections: 0,
    transport() {
      const pair = createInMemoryTransportPair();
      server.connections++;
      open.add(pair.server);
      pair.server.onClose(() => open.delete(pair.server));
      pair.server.onMessage((message) => {
        void server.handle(message).then((answer) => {
          if (answer) void pair.server.send(answer).catch(() => undefined);
        });
      });
      void pair.server.start();
      return pair.client;
    },
    async notify(method, params) {
      for (const transport of open)
        await transport.send({ jsonrpc: "2.0", method, params });
    },
    async handle(message) {
      if (!("method" in message)) return undefined;
      const { method, params } = message as {
        method: string;
        params?: Record<string, unknown>;
      };
      server.received.push({ method, params });
      if (!("id" in message) || message.id === undefined) return undefined;
      const id = message.id;
      const result = (value: unknown): JsonRpcMessage =>
        ({ jsonrpc: "2.0", id, result: value }) as JsonRpcMessage;
      const current = server.options;
      switch (method) {
        case "initialize":
          return result({
            protocolVersion:
              (params?.protocolVersion as string) ?? "2025-06-18",
            capabilities: {
              ...(current.tools ? { tools: { listChanged: true } } : {}),
              ...(current.resources ? { resources: {} } : {}),
            },
            serverInfo: { name: "fake", version: current.version ?? "1.2.3" },
            ...(current.instructions
              ? { instructions: current.instructions }
              : {}),
          });
        case "ping":
          return result({});
        case "tools/list":
          return result({ tools: current.tools ?? [] });
        case "tools/call":
          return result(
            await (current.call?.(
              params?.name as string,
              (params?.arguments ?? {}) as Record<string, unknown>,
            ) ?? { content: [{ type: "text", text: "ok" }] }),
          );
        case "resources/list":
          return result({
            resources: (current.resources ?? []).map(({ uri, name }) => ({
              uri,
              name,
            })),
            _meta: { internal: true },
          });
        case "resources/read": {
          const found = (current.resources ?? []).find(
            (resource) => resource.uri === params?.uri,
          );
          if (!found)
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32002, message: "Resource not found" },
            } as JsonRpcMessage;
          return result({ contents: [{ uri: found.uri, text: found.text }] });
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          } as JsonRpcMessage;
      }
    },
  };
  return server;
}

/**
 * A `fetch` that is this server over Streamable HTTP at `url`, answering
 * each POST with one JSON response. `authorize` sees every request first: a
 * Response it returns (a 401, say) is the answer.
 */
export function fakeHttp(
  server: FakeServer,
  url: string,
  authorize?: (request: Request) => Response | undefined,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request = new Request(input as string | URL, init);
    if (new URL(request.url).href !== new URL(url).href)
      return new Response("not found", { status: 404 });
    const refused = authorize?.(request);
    if (refused) return refused;
    if (request.method === "GET") return new Response(null, { status: 405 });
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    const answer = await server.handle(
      JSON.parse(await request.text()) as JsonRpcMessage,
    );
    if (!answer) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(answer), {
      headers: { "content-type": "application/json" },
    });
  };
}
