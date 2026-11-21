import { createHash } from "node:crypto";
import type { CallToolResult, Tool } from "@earendil-works/pi-mcp";
import * as t from "typebox";
import { Check } from "typebox/value";
import { MCP_OWNER_PREFIX } from "../connections/types.js";
import type {
  ActionContext,
  ActionDef,
  ActionHints,
  PluginDef,
  TypedInputSchema,
} from "../plugin/types.js";
import type { McpServerSnapshot } from "./cache.js";
import { isRecord, loadsTool, type McpServer } from "./config.js";
import { McpServerError } from "./errors.js";

/** The owner of a server's connection: no other plugin of its name may use it. */
export function mcpOwner(server: string): string {
  return `${MCP_OWNER_PREFIX}${server}`;
}

/** How long a failed tool's own text may be in the error it becomes. */
const MAX_ERROR_CHARS = 1_000;

/**
 * The action name of each tool. Everything but `[A-Za-z0-9_]` becomes `_`,
 * as in pi and Codex, so a name is also how code writes the call. Tools
 * whose names then collide all get a hash of their own name, so none of
 * them silently takes the plain one.
 */
export function actionNames(tools: readonly string[]): Map<string, string> {
  const sanitized = tools.map((tool) => tool.replace(/[^A-Za-z0-9_]/g, "_"));
  const count = new Map<string, number>();
  for (const name of sanitized) count.set(name, (count.get(name) ?? 0) + 1);
  return new Map(
    tools.map((tool, index) => {
      const name = sanitized[index];
      if (count.get(name) === 1 && name) return [tool, name];
      const hash = createHash("sha256").update(tool).digest("hex").slice(0, 8);
      return [tool, `${name}_${hash}`];
    }),
  );
}

/**
 * A tool's input schema as the engine validates it. MCP requires an object
 * schema and servers may omit `type`. A schema the validator cannot
 * evaluate (an unresolved `$ref`) is replaced by a bare object, leaving the
 * check to the server.
 */
function inputSchema(tool: Tool): TypedInputSchema {
  const schema = { ...tool.inputSchema, type: "object" } as TypedInputSchema;
  try {
    Check(schema, {});
    return schema;
  } catch {
    return t.Object({}, { additionalProperties: true });
  }
}

function hints(tool: Tool): ActionHints | undefined {
  const { destructiveHint, idempotentHint, openWorldHint } =
    tool.annotations ?? {};
  const found: ActionHints = {
    ...(typeof destructiveHint === "boolean"
      ? { destructive: destructiveHint }
      : {}),
    ...(typeof idempotentHint === "boolean"
      ? { idempotent: idempotentHint }
      : {}),
    ...(typeof openWorldHint === "boolean" ? { openWorld: openWorldHint } : {}),
  };
  return Object.keys(found).length ? found : undefined;
}

/**
 * What a tool call returns to code: the whole result without the
 * protocol's `_meta`. A tool that reports its own failure (`isError`)
 * throws instead, with its text as the message: in codemode a call that
 * resolves has worked.
 */
export function toolResult(
  server: string,
  tool: string,
  result: CallToolResult,
): unknown {
  const { _meta, ...rest } = result;
  if (!result.isError) return rest;
  // The client checks that `content` is an array, not what it holds.
  const text =
    (result.content as unknown[])
      .flatMap((block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("\n")
      .trim() ||
    (result.structuredContent === undefined
      ? ""
      : JSON.stringify(result.structuredContent));
  throw new McpServerError(
    "tool_failed",
    text.length > MAX_ERROR_CHARS
      ? `${text.slice(0, MAX_ERROR_CHARS)}…`
      : text || `MCP tool "${tool}" of server "${server}" reported an error`,
    { server },
  );
}

/** What a server's plugin calls back into: the manager's sessions. */
export interface McpServerCalls {
  tool(tool: string, input: unknown, ctx: ActionContext): Promise<unknown>;
  resources(input: unknown, ctx: ActionContext): Promise<unknown>;
  resourceTemplates(input: unknown, ctx: ActionContext): Promise<unknown>;
  readResource(input: unknown, ctx: ActionContext): Promise<unknown>;
}

const Page = t.Object(
  {
    cursor: t.Optional(
      t.String({ description: "nextCursor of the page before" }),
    ),
  },
  { additionalProperties: false },
);

/**
 * The actions of a server that offers resources. Their names have a dot,
 * which no tool's action name has.
 */
function resourceActions(calls: McpServerCalls): ActionDef[] {
  return [
    {
      name: "resources.list",
      access: "read",
      description:
        "List one page of the server's resources: files, records and other data it can be asked to read.",
      inputSchema: Page,
      execute: calls.resources,
    },
    {
      name: "resources.templates",
      access: "read",
      description:
        "List one page of the server's resource templates: URI patterns (RFC 6570) that name families of resources.",
      inputSchema: Page,
      execute: calls.resourceTemplates,
    },
    {
      name: "resources.read",
      access: "read",
      description:
        "Read one resource by its URI, as listed, built from a template, or linked from a tool's result.",
      inputSchema: t.Object(
        { uri: t.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      execute: calls.readResource,
    },
  ];
}

/** The tools of a server's list that its entry loads. */
export function loadedTools(server: McpServer, tools: Tool[]): Tool[] {
  return tools.filter((tool) => loadsTool(server.config, tool.name));
}

/**
 * A server as a plugin: one action per tool its entry loads, and the
 * resource actions when it offers resources. Without a snapshot (never
 * connected, or the connection failed) it has no actions.
 */
export function serverPlugin(
  server: McpServer,
  snapshot: McpServerSnapshot | undefined,
  calls: McpServerCalls,
): PluginDef {
  const tools = loadedTools(server, snapshot?.tools ?? []);
  const names = actionNames(tools.map((tool) => tool.name));
  const actions: ActionDef[] = tools.map((tool) => {
    const name = names.get(tool.name) ?? tool.name;
    const description = tool.description?.trim() || tool.title?.trim();
    const hinted = hints(tool);
    return {
      name,
      // The server's own claim. Only an explicit read-only hint makes a read.
      access: tool.annotations?.readOnlyHint === true ? "read" : "write",
      ...(description ? { description } : {}),
      inputSchema: inputSchema(tool),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(hinted ? { hints: hinted } : {}),
      ...(name === tool.name ? {} : { sourceName: tool.name }),
      execute: (input, ctx) => calls.tool(tool.name, input, ctx),
    };
  });
  const description =
    server.config.description?.trim() || snapshot?.instructions?.trim();
  return {
    name: server.plugin,
    version: snapshot?.version ?? "0.0.0",
    ...(description ? { description } : {}),
    actions: snapshot?.resources
      ? [...actions, ...resourceActions(calls)]
      : actions,
    sourceInfo: {
      path: server.source,
      source: server.source,
      origin: "mcp",
      scope: server.scope,
      owner: mcpOwner(server.name),
    },
  };
}
