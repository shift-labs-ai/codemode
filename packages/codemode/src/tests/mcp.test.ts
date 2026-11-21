/**
 * MCP servers as plugins: what `McpManager` reads, loads, calls and closes.
 * Servers here are the in-memory one of `helpers/mcp-server.ts`, except
 * where a case is about a real process.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isMcpServerOverride,
  type Tool,
  validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import { MemoryConnectionProvider } from "../connections/memory.js";
import { FileMcpToolCache, MemoryMcpToolCache } from "../mcp/cache.js";
import {
  loadsTool,
  type McpServerEntry,
  resolveServers,
} from "../mcp/config.js";
import { isMcpServerError } from "../mcp/errors.js";
import {
  type McpEvent,
  McpManager,
  type McpManagerOptions,
} from "../mcp/manager.js";
import { actionNames } from "../mcp/plugin.js";
import type { McpTransportRequest } from "../mcp/session.js";
import { FileMcpStore, MemoryMcpStore } from "../mcp/store.js";
import { discoverPlugins, enabledBuiltins } from "../plugin/loader.js";
import type { ActionContext } from "../plugin/types.js";
import { Codemode } from "../sdk.js";
import {
  type FakeServer,
  fakeHttp,
  fakeServer,
  placeholder,
} from "./helpers/mcp-server.js";

const STDIO_SERVER = fileURLToPath(
  new URL("./helpers/mcp-stdio-server.mjs", import.meta.url),
);

const SEARCH: Tool = {
  name: "search-issues",
  description: "Search issues",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
  annotations: { readOnlyHint: true, openWorldHint: true },
};
const DELETE: Tool = {
  name: "delete_issue",
  title: "Delete an issue",
  inputSchema: { properties: { id: { type: "string" } } },
  annotations: { destructiveHint: true, idempotentHint: true },
};

const check = {
  validate: validateMcpServerConfig,
  isOverride: isMcpServerOverride,
};

let tmp: string;
const managers: McpManager[] = [];
const instances: Codemode[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codemode-mcp-"));
});

afterEach(async () => {
  for (const codemode of instances.splice(0)) codemode.dispose();
  for (const manager of managers.splice(0)) await manager.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A manager over servers held in memory, each reached through `transports`. */
function manager(
  servers: Record<string, unknown>,
  transports: Record<string, FakeServer>,
  options: Partial<McpManagerOptions> & {
    project?: Record<string, unknown>;
    requests?: McpTransportRequest[];
  } = {},
): McpManager {
  const { project, requests, ...rest } = options;
  const created = new McpManager({
    store: new MemoryMcpStore({ user: servers, project }),
    createTransport: (request) => {
      requests?.push(request);
      const server = transports[request.server];
      if (!server) throw new Error(`no fake server for ${request.server}`);
      return server.transport();
    },
    environment: {},
    variable: () => undefined,
    ...rest,
  });
  managers.push(created);
  return created;
}

function codemodeWith(
  ...options: Parameters<typeof Codemode.create>
): Codemode {
  const created = Codemode.create(...options);
  instances.push(created);
  return created;
}

describe("server entries", () => {
  const source = (source: string, servers: Record<string, unknown>) => ({
    source,
    servers,
  });

  it("reads both places of a scope and reports a name defined twice", () => {
    const { servers, problems } = resolveServers(
      {
        user: [
          source("config.json", { files: { command: "a" } }),
          source("mcp.json", {
            files: { command: "b" },
            docs: { url: "https://example.com/mcp" },
          }),
        ],
      },
      check,
    );
    assert.deepEqual(
      servers.map((server) => [server.name, server.kind, server.source]),
      [
        ["files", "stdio", "config.json"],
        ["docs", "http", "mcp.json"],
      ],
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0].level, "warning");
    assert.match(problems[0].message, /config\.json and in mcp\.json/);
  });

  it("lets a project entry replace the user's, or override a few of its fields", () => {
    const { servers, problems } = resolveServers(
      {
        user: [
          source("user", {
            a: { command: "user-a" },
            b: { command: "user-b", env: { KEY: "kept" } },
          }),
        ],
        project: [
          source("project", {
            a: { command: "project-a" },
            b: { enabled: false, tools: ["read_*"] },
          }),
        ],
      },
      check,
    );
    assert.deepEqual(problems, []);
    const a = servers.find((server) => server.name === "a");
    assert.equal(a?.scope, "project");
    assert.equal((a?.config as { command: string }).command, "project-a");
    const b = servers.find((server) => server.name === "b");
    assert.equal(b?.scope, "user");
    assert.equal(b?.enabled, false);
    assert.deepEqual(b?.config.tools, ["read_*"]);
    assert.deepEqual((b?.config as { env: unknown }).env, { KEY: "kept" });
  });

  it("refuses an override of anything but the fields a project may change", () => {
    const { servers, problems } = resolveServers(
      {
        user: [source("user", { a: { command: "x" } })],
        project: [source("project", { a: { env: { PATH: "/evil" } } })],
      },
      check,
    );
    assert.deepEqual(servers, []);
    assert.match(problems[0].message, /may set only enabled, tools/);
  });

  it("names a server in code with - as _, and keeps one of two that then collide", () => {
    const { servers, problems } = resolveServers(
      {
        user: [
          source("user", {
            "dev-radius": { command: "x" },
            dev_radius: { command: "y" },
          }),
        ],
      },
      check,
    );
    assert.deepEqual(
      servers.map((server) => [server.name, server.plugin]),
      [["dev-radius", "dev_radius"]],
    );
    assert.equal(problems[0].code, "name_conflict");
    assert.match(problems[0].message, /"dev_radius"/);
  });

  it("refuses a name that cannot be written in code", () => {
    const { servers, problems } = resolveServers(
      {
        user: [
          source("user", {
            "9lives": { command: "x" },
            require: { command: "x" },
            class: { command: "x" },
          }),
        ],
      },
      check,
    );
    assert.deepEqual(servers, []);
    assert.equal(problems.length, 3);
    for (const problem of problems)
      assert.match(problem.message, /cannot be named in code/);
  });

  it("reports an invalid entry and keeps the others", () => {
    const { servers, problems } = resolveServers(
      {
        user: [
          source("user", {
            good: { command: "x" },
            sse: { type: "sse", url: "https://example.com/sse" },
            neither: {},
            shell: { command: "x", env: { TOKEN: "!gh auth token" } },
            filter: { command: "x", tools: "all" },
          }),
        ],
      },
      check,
    );
    assert.deepEqual(
      servers.map((server) => server.name),
      ["good"],
    );
    const messages = problems.map((problem) => problem.message).join("\n");
    assert.match(messages, /legacy SSE transport is not supported/);
    assert.match(messages, /needs either "command"/);
    assert.match(messages, /never runs a command for a value/);
    assert.match(messages, /tools must be an array/);
  });

  it("reports a place it could not read", () => {
    const { problems } = resolveServers(
      { user: [{ source: "mcp.json", servers: {}, error: "malformed JSON" }] },
      check,
    );
    assert.match(
      problems[0].message,
      /mcp\.json were not read: malformed JSON/,
    );
  });

  it("selects tools by name and pattern, and reads pi's exposure fields", () => {
    const entry = (fields: object) =>
      ({ command: "x", ...fields }) as McpServerEntry;
    assert.equal(loadsTool(entry({}), "anything"), true);
    const filtered = entry({ tools: ["get_*", "search", "!get_secret"] });
    assert.equal(loadsTool(filtered, "get_issue"), true);
    assert.equal(loadsTool(filtered, "search"), true);
    assert.equal(loadsTool(filtered, "get_secret"), false);
    assert.equal(loadsTool(filtered, "delete_issue"), false);
    assert.equal(loadsTool(entry({ tools: ["!delete_*"] }), "get_issue"), true);
    assert.equal(loadsTool(entry({ tools: ["a.b"] }), "aXb"), false);
    const hidden = entry({
      exposure: "hidden",
      toolExposure: { "read_*": "direct", read_secret: "hidden" },
    });
    assert.equal(loadsTool(hidden, "read_file"), true);
    assert.equal(loadsTool(hidden, "read_secret"), false);
    assert.equal(loadsTool(hidden, "write_file"), false);
  });

  it("does not load a hidden server with no tool exposed", () => {
    const { servers } = resolveServers(
      {
        user: [
          source("user", {
            off: { command: "x", exposure: "hidden" },
            partly: {
              command: "x",
              exposure: "hidden",
              toolExposure: { one: "codemode" },
            },
          }),
        ],
      },
      check,
    );
    assert.deepEqual(
      servers.map((server) => [server.name, server.enabled]),
      [
        ["off", false],
        ["partly", true],
      ],
    );
  });
});

describe("tool names", () => {
  it("makes every name an identifier, and marks all that collide", () => {
    const names = actionNames(["get-issue", "get_issue", "list.all", "ok"]);
    assert.equal(names.get("ok"), "ok");
    assert.equal(names.get("list.all"), "list_all");
    assert.match(names.get("get-issue") ?? "", /^get_issue_[0-9a-f]{8}$/);
    assert.match(names.get("get_issue") ?? "", /^get_issue_[0-9a-f]{8}$/);
    assert.notEqual(names.get("get-issue"), names.get("get_issue"));
  });
});

describe("loading servers as plugins", () => {
  it("makes a server a plugin and its tools actions", async () => {
    const server = fakeServer({
      tools: [SEARCH, DELETE],
      instructions: "Tools for the issue tracker.",
      version: "4.5.6",
    });
    const mcp = manager(
      { "issue-tracker": { command: "x" } },
      { "issue-tracker": server },
    );
    const { plugins, problems } = await mcp.load();
    assert.deepEqual(problems, []);
    const [plugin] = plugins;
    assert.equal(plugin.name, "issue_tracker");
    assert.equal(plugin.version, "4.5.6");
    assert.equal(plugin.description, "Tools for the issue tracker.");
    assert.deepEqual(plugin.sourceInfo, {
      path: "user MCP servers",
      source: "user MCP servers",
      origin: "mcp",
      scope: "user",
      owner: "mcp:issue-tracker",
    });
    const [search, remove] = plugin.actions;
    assert.equal(search.name, "search_issues");
    assert.equal(search.sourceName, "search-issues");
    assert.equal(search.access, "read");
    assert.equal(search.description, "Search issues");
    assert.deepEqual(search.outputSchema, SEARCH.outputSchema);
    assert.deepEqual(search.hints, { openWorld: true });
    assert.equal(remove.name, "delete_issue");
    assert.equal(remove.sourceName, undefined);
    assert.equal(remove.access, "write");
    assert.equal(remove.description, "Delete an issue");
    assert.deepEqual(remove.hints, { destructive: true, idempotent: true });
    assert.equal((remove.inputSchema as { type: string }).type, "object");
  });

  it("prefers the entry's description to the server's instructions", async () => {
    const server = fakeServer({
      tools: [SEARCH],
      instructions: "From the server.",
    });
    const mcp = manager(
      { a: { command: "x", description: "From the entry." } },
      { a: server },
    );
    assert.equal((await mcp.load()).plugins[0].description, "From the entry.");
  });

  it("loads only the tools the entry selects, and no disabled server", async () => {
    const server = fakeServer({ tools: [SEARCH, DELETE] });
    const mcp = manager(
      {
        a: { command: "x", tools: ["!delete_*"] },
        off: { command: "x", enabled: false },
      },
      { a: server, off: server },
    );
    const { plugins } = await mcp.load();
    assert.deepEqual(
      plugins.map((plugin) => [plugin.name, plugin.actions.map((a) => a.name)]),
      [["a", ["search_issues"]]],
    );
    assert.equal(server.connections, 1);
  });

  it("builds a server from its cached tool list without connecting", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const cache = new MemoryMcpToolCache();
    const servers = { a: { command: "x" } };
    await manager(servers, { a: server }, { cache }).load();
    assert.equal(server.connections, 1);

    const { plugins } = await manager(servers, { a: server }, { cache }).load();
    assert.equal(server.connections, 1);
    assert.deepEqual(
      plugins[0].actions.map((action) => action.name),
      ["search_issues"],
    );
  });

  it("does not use a tool list cached through another entry", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const cache = new MemoryMcpToolCache();
    await manager({ a: { command: "x" } }, { a: server }, { cache }).load();
    await manager({ a: { command: "y" } }, { a: server }, { cache }).load();
    assert.equal(server.connections, 2);
    // A changed filter or description selects nothing new to start.
    await manager(
      { a: { command: "y", tools: ["search-*"], description: "d" } },
      { a: server },
      { cache },
    ).load();
    assert.equal(server.connections, 2);
  });

  it("loads an uncached server with no actions when asked not to connect", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ a: { command: "x" } }, { a: server });
    const { plugins, problems } = await mcp.load({ connect: false });
    assert.deepEqual(problems, []);
    assert.deepEqual(plugins[0].actions, []);
    assert.equal(plugins[0].sourceInfo?.owner, "mcp:a");
    assert.equal(server.connections, 0);
  });

  it("reports a server it cannot reach and still loads the others", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager(
      { good: { command: "x" }, broken: { command: "x" } },
      { good: server },
    );
    const { plugins, problems } = await mcp.load();
    assert.deepEqual(
      plugins.map((plugin) => [plugin.name, plugin.actions.length]),
      [
        ["good", 1],
        ["broken", 0],
      ],
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, "connect_failed");
    assert.match(problems[0].message, /"broken" failed to connect/);
  });

  it("leaves a server that failed alone for a while, then tries it again", async () => {
    const cache = new MemoryMcpToolCache();
    const requests: McpTransportRequest[] = [];
    const servers = { broken: { command: "x" } };
    const load = (retryFailedAfterMs?: number) =>
      manager(servers, {}, { cache, requests, retryFailedAfterMs }).load();

    const first = await load();
    assert.match(first.problems[0].message, /"broken" failed to connect/);
    assert.equal(requests.length, 1);

    const second = await load();
    assert.equal(requests.length, 1);
    assert.equal(second.problems[0].code, "connect_failed");
    assert.match(
      second.problems[0].message,
      /"broken" failed to connect.*\(Not tried again for \d+ s\.\)/s,
    );
    assert.deepEqual(second.plugins[0].actions, []);

    await load(0);
    assert.equal(requests.length, 2);

    // Asking for its status always tries, and a success replaces the record.
    const server = fakeServer({ tools: [SEARCH] });
    const working = manager(servers, { broken: server }, { cache });
    assert.equal((await working.status("broken"))[0].state, "connected");
    const healed = await working.load();
    assert.deepEqual(healed.problems, []);
    assert.equal(healed.plugins[0].actions.length, 1);
    assert.equal((await working.list())[0].cachedTools, 1);
  });

  it("gives up on a server that does not answer", async () => {
    const mcp = new McpManager({
      store: new MemoryMcpStore({ user: { slow: { command: "x" } } }),
      // A transport that starts and never answers.
      createTransport: () => ({
        start: async () => {},
        send: async () => {},
        close: async () => {},
        onMessage: () => () => {},
        onError: () => () => {},
        onClose: () => () => {},
      }),
      connectTimeoutMs: 50,
    });
    managers.push(mcp);
    const { problems } = await mcp.load();
    assert.match(problems[0].message, /no answer within/);
  });

  it("refuses a server whose name a plugin in use has", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager(
      { github: { command: "x" }, other: { command: "x" } },
      { github: server, other: server },
    );
    const { plugins, problems } = await mcp.load({ reservedNames: ["github"] });
    assert.deepEqual(
      plugins.map((plugin) => plugin.name),
      ["other"],
    );
    assert.equal(problems[0].code, "name_conflict");
    assert.match(problems[0].message, /a plugin named "github" is in use/);
    assert.equal(server.connections, 1);
  });

  it("starts none of a project's servers until the project is trusted", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const project = { p: { command: "x" } };
    const untrusted = manager({}, { p: server }, { project });
    const first = await untrusted.load();
    assert.deepEqual(first.plugins, []);
    assert.equal(first.problems[0].code, "untrusted");
    assert.match(first.problems[0].message, /1 MCP server\(s\)/);
    assert.equal(server.connections, 0);

    const trusted = manager({}, { p: server }, { project, trust: () => true });
    const second = await trusted.load();
    assert.deepEqual(second.problems, []);
    assert.equal(second.plugins[0].sourceInfo?.scope, "project");
  });

  it("loads nothing when no server is configured", async () => {
    const mcp = manager({}, {});
    assert.deepEqual(await mcp.load(), { plugins: [], problems: [] });
    assert.deepEqual(await mcp.list(), []);
  });
});

describe("calling a server's tools from code", () => {
  it("returns the whole result without the protocol's _meta", async () => {
    const server = fakeServer({
      tools: [SEARCH],
      call: (_name, args) => ({
        content: [{ type: "text", text: "2 issues" }],
        structuredContent: { total: 2, args },
        _meta: { trace: "x" },
      }),
    });
    const mcp = manager({ tracker: { command: "x" } }, { tracker: server });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    const { result, error } = await codemode.execute(
      `return await tracker.search_issues({ query: "open" })`,
    );
    assert.equal(error, undefined);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "2 issues" }],
      structuredContent: { total: 2, args: { query: "open" } },
    });
    const call = server.received.find((r) => r.method === "tools/call");
    assert.deepEqual((call?.params as { name: string }).name, "search-issues");
  });

  it("rejects when the tool reports its own failure, with the tool's text", async () => {
    const server = fakeServer({
      tools: [DELETE],
      call: () => ({
        content: [
          { type: "text", text: "Issue 7 is locked." },
          { type: "text", text: "Unlock it first." },
        ],
        isError: true,
      }),
    });
    const mcp = manager({ tracker: { command: "x" } }, { tracker: server });
    const failures: unknown[] = [];
    const codemode = codemodeWith({
      plugins: (await mcp.load()).plugins,
      onAction: (info) => {
        if (info.error) failures.push(info.error);
      },
    });
    const caught = await codemode.execute(`
      try { await tracker.delete_issue({ id: "7" }); return "resolved"; }
      catch (e) { return e.message; }
    `);
    assert.equal(caught.result, "Issue 7 is locked.\nUnlock it first.");
    assert.equal(failures.length, 1);
    assert.ok(isMcpServerError(failures[0]));
    assert.equal(failures[0].code, "tool_failed");

    const uncaught = await codemode.execute(
      `return await tracker.delete_issue({ id: "7" })`,
    );
    assert.equal(uncaught.result, null);
    assert.match(uncaught.error ?? "", /Issue 7 is locked/);
  });

  it("reads a failed tool's text past a content block that is not one", async () => {
    const server = fakeServer({
      tools: [DELETE],
      call: () =>
        ({
          content: [null, "text", { type: "text", text: "Locked." }],
          isError: true,
        }) as never,
    });
    const mcp = manager({ tracker: { command: "x" } }, { tracker: server });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    const { error } = await codemode.execute(
      `return await tracker.delete_issue({ id: "7" })`,
    );
    assert.match(error ?? "", /Locked\./);
  });

  it("checks input against the tool's schema before the server is called", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ tracker: { command: "x" } }, { tracker: server });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    const { error } = await codemode.execute(
      `return await tracker.search_issues({ query: 5 })`,
    );
    assert.match(error ?? "", /Invalid input for tracker\.search_issues/);
    assert.equal(
      server.received.some((r) => r.method === "tools/call"),
      false,
    );
    const checked = await codemode.execute(
      `return actions.check("tracker.search_issues", {})`,
    );
    assert.deepEqual((checked.result as { missing: string[] }).missing, [
      "query",
    ]);
  });

  it("describes a server and its tools through discovery", async () => {
    const server = fakeServer({
      tools: [SEARCH, DELETE],
      instructions: "Issues.",
    });
    const mcp = manager({ tracker: { command: "x" } }, { tracker: server });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    const { result } = await codemode.execute(`return {
      plugin: actions.plugin("tracker"),
      search: actions.describe("tracker.search_issues"),
      found: actions.find("delete an issue").map((hit) => hit.path),
    }`);
    const found = result as {
      plugin: unknown;
      search: Record<string, unknown>;
      found: string[];
    };
    assert.deepEqual(found.plugin, {
      name: "tracker",
      description: "Issues.",
      actions: ["tracker.search_issues", "tracker.delete_issue"],
    });
    assert.equal(found.search.access, "read");
    assert.equal(found.search.sourceName, "search-issues");
    assert.deepEqual(found.search.hints, { openWorld: true });
    assert.deepEqual(found.search.outputSchema, SEARCH.outputSchema);
    assert.ok(found.found.includes("tracker.delete_issue"));
  });

  it("cancels a tool call on the server when the run ends first", async () => {
    const server = fakeServer({
      tools: [SEARCH],
      call: () => new Promise(() => {}),
    });
    const mcp = manager({ tracker: { command: "x" } }, { tracker: server });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    // Long enough for the call to reach the server on a slow machine: a
    // run that times out before it has made the call has none to cancel.
    const { error } = await codemode.execute(
      `return await tracker.search_issues({ query: "x" })`,
      { timeoutMs: 1_000 },
    );
    assert.match(error ?? "", /timed out/);
    assert.ok(
      server.received.some((r) => r.method === "tools/call"),
      "the call reached the server",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      server.received.some((r) => r.method === "notifications/cancelled"),
      "the server was told the call is cancelled",
    );
  });

  it("names the server that did not answer within its timeout", async () => {
    const server = fakeServer({
      tools: [SEARCH],
      call: () => new Promise(() => {}),
    });
    const mcp = manager(
      { tracker: { command: "x", timeout: 0.05 } },
      { tracker: server },
    );
    const failures: unknown[] = [];
    const codemode = codemodeWith({
      plugins: (await mcp.load()).plugins,
      onAction: (info) => {
        failures.push(info.error);
      },
    });
    const { error } = await codemode.execute(
      `return await tracker.search_issues({ query: "x" })`,
    );
    assert.match(
      error ?? "",
      /MCP server "tracker" did not answer within 0\.05 s/,
    );
    assert.ok(isMcpServerError(failures[0]));
    assert.equal(failures[0].code, "timed_out");
  });

  it("connects on the first call when the tool list came from the cache", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const cache = new MemoryMcpToolCache();
    const servers = { tracker: { command: "x" } };
    await manager(servers, { tracker: server }, { cache }).load();
    for (const opened of managers.splice(0)) await opened.close();

    const mcp = manager(servers, { tracker: server }, { cache });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    assert.equal(server.connections, 1);
    await codemode.execute(
      `return await tracker.search_issues({ query: "x" })`,
    );
    await codemode.execute(
      `return await tracker.search_issues({ query: "y" })`,
    );
    assert.equal(server.connections, 2);
  });

  it("opens one session for calls made in the same instant on a server not yet connected", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const cache = new MemoryMcpToolCache();
    const servers = { tracker: { command: "x" } };
    await manager(servers, { tracker: server }, { cache }).load();
    for (const opened of managers.splice(0)) await opened.close();

    const mcp = manager(servers, { tracker: server }, { cache });
    const [search] = (await mcp.load()).plugins[0].actions;
    // Called directly, so both calls start before either has a session.
    const ctx: ActionContext = {
      connection: { name: "tracker", plugin: "tracker", config: {} },
      log: { info() {}, warn() {}, error() {} },
      async updateConnection() {},
    };
    await Promise.all([
      search.execute({ query: "a" }, ctx),
      search.execute({ query: "b" }, ctx),
      search.execute({ query: "c" }, ctx),
    ]);
    assert.equal(server.connections, 2);
  });

  it("reconnects after its sessions were closed", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ tracker: { command: "x" } }, { tracker: server });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    await codemode.execute(
      `return await tracker.search_issues({ query: "x" })`,
    );
    await mcp.close();
    const { error } = await codemode.execute(
      `return await tracker.search_issues({ query: "y" })`,
    );
    assert.equal(error, undefined);
    assert.equal(server.connections, 2);
  });

  it("lists and reads a server's resources", async () => {
    const server = fakeServer({
      tools: [SEARCH],
      resources: [{ uri: "note://1", name: "First", text: "hello" }],
    });
    const mcp = manager({ notes: { command: "x" } }, { notes: server });
    const { plugins } = await mcp.load();
    assert.deepEqual(
      plugins[0].actions.map((action) => [action.name, action.access]),
      [
        ["search_issues", "read"],
        ["resources.list", "read"],
        ["resources.templates", "read"],
        ["resources.read", "read"],
      ],
    );
    const codemode = codemodeWith({ plugins });
    const { result, error } = await codemode.execute(`
      const listed = await notes.resources.list();
      const templates = await notes.resources.templates();
      const read = await notes.resources.read({ uri: listed.resources[0].uri });
      return { listed, templates, read };
    `);
    assert.equal(error, undefined);
    assert.deepEqual(result, {
      listed: { resources: [{ uri: "note://1", name: "First" }] },
      templates: { resourceTemplates: [] },
      read: { contents: [{ uri: "note://1", text: "hello" }] },
    });
  });

  it("offers no resource actions for a server without resources", async () => {
    const mcp = manager(
      { a: { command: "x" } },
      { a: fakeServer({ tools: [SEARCH] }) },
    );
    const { plugins } = await mcp.load();
    assert.deepEqual(
      plugins[0].actions.map((action) => action.name),
      ["search_issues"],
    );
  });
});

describe("connections and sessions", () => {
  const entry = {
    docs: {
      url: "https://docs.example.com/mcp",
      headers: {
        Authorization: `Bearer ${placeholder("token")}`,
        "X-Org": "$ORG",
        "X-Cost": "$$5",
      },
    },
  };

  it("fills an entry's placeholders from the connection, then from variables", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const requests: McpTransportRequest[] = [];
    const mcp = manager(
      entry,
      { docs: server },
      {
        requests,
        variable: (name) => (name === "ORG" ? "acme" : undefined),
        connections: new MemoryConnectionProvider([
          {
            name: "docs",
            plugin: "docs",
            owner: "mcp:docs",
            config: { token: "s3cret" },
          },
        ]),
      },
    );
    assert.deepEqual((await mcp.load()).problems, []);
    assert.deepEqual(requests[0], {
      kind: "http",
      url: "https://docs.example.com/mcp",
      headers: {
        Authorization: "Bearer s3cret",
        "X-Org": "acme",
        "X-Cost": "$5",
      },
      server: "docs",
      onStderr: requests[0].onStderr,
    });
  });

  it("reports a placeholder nothing holds, naming it and never sending an empty value", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager(entry, { docs: server }, { variable: () => undefined });
    const { problems } = await mcp.load();
    assert.equal(problems[0].code, "invalid_config");
    assert.match(problems[0].message, /headers\.Authorization needs "token"/);
    assert.equal(server.connections, 0);
  });

  it("gives a stdio server only the inherited names and its entry's env", async () => {
    const requests: McpTransportRequest[] = [];
    const mcp = manager(
      {
        files: {
          command: "~/bin/files",
          args: ["~/data"],
          env: { KEY: placeholder("key") },
          cwd: "sub",
        },
      },
      { files: fakeServer({ tools: [SEARCH] }) },
      {
        requests,
        environment: { PATH: "/usr/bin", EMPTY: undefined },
        connections: new MemoryConnectionProvider([
          {
            name: "files",
            plugin: "files",
            owner: "mcp:files",
            config: { key: "k" },
          },
        ]),
      },
    );
    await mcp.load();
    const [request] = requests;
    assert.equal(request.kind, "stdio");
    if (request.kind !== "stdio") return;
    assert.deepEqual(request.env, { PATH: "/usr/bin", KEY: "k" });
    assert.equal(request.command.startsWith("~"), false);
    assert.equal(request.args[0].endsWith("/data"), true);
    assert.ok(request.cwd?.endsWith("/sub"));
  });

  it("keeps one session per connection, and a new one when a secret changes", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const cache = new MemoryMcpToolCache();
    await manager(
      entry,
      { docs: server },
      {
        cache,
        variable: () => "v",
      },
    ).load({ connect: true });
    for (const opened of managers.splice(0)) await opened.close();
    const before = server.connections;

    const requests: McpTransportRequest[] = [];
    const mcp = manager(
      entry,
      { docs: server },
      { cache, requests, variable: () => "acme" },
    );
    const { plugins } = await mcp.load();
    const run = async (token: string, name = "docs") => {
      const codemode = codemodeWith({
        plugins,
        connections: [
          { name, plugin: "docs", owner: "mcp:docs", config: { token } },
        ],
      });
      const { error } = await codemode.execute(
        `return await docs.search_issues({ query: "x" })`,
      );
      assert.equal(error, undefined);
    };
    await run("one");
    await run("one");
    assert.equal(server.connections - before, 1);
    await run("two");
    assert.equal(server.connections - before, 2);
    await run("one", "another-person");
    assert.equal(server.connections - before, 3);
    assert.deepEqual(
      requests.map(
        (request) => request.kind === "http" && request.headers.Authorization,
      ),
      ["Bearer one", "Bearer two", "Bearer one"],
    );
  });

  it("keeps a tool list for each identity a host tells apart", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const cache = new MemoryMcpToolCache();
    const load = (person: string) =>
      manager(
        { a: { command: "x" } },
        { a: server },
        {
          cache,
          connections: new MemoryConnectionProvider(),
          identity: (_connection, context) => String(context),
        },
      ).load({ context: person });

    await load("ann");
    assert.equal(server.connections, 1);
    // Ann's list is cached; Bo has none yet, and what he sees may differ.
    server.options.tools = [SEARCH, DELETE];
    assert.equal((await load("ann")).plugins[0].actions.length, 1);
    assert.equal(server.connections, 1);
    assert.equal((await load("bo")).plugins[0].actions.length, 2);
    assert.equal(server.connections, 2);

    assert.equal((await cache.read("user", "a", "ann"))?.tools.length, 1);
    assert.equal((await cache.read("user", "a", "bo"))?.tools.length, 2);
    assert.equal(await cache.read("user", "a"), undefined);
    const mcp = manager(
      { a: { command: "x" } },
      { a: server },
      { cache, identity: (_connection, context) => String(context) },
    );
    assert.equal((await mcp.list({ context: "bo" }))[0].cachedTools, 2);
    await mcp.remove("a");
    assert.equal(await cache.read("user", "a", "ann"), undefined);
  });

  it("refuses a connection made for another owner of the same name", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ github: { command: "x" } }, { github: server });
    const { plugins } = await mcp.load();
    const codemode = codemodeWith({
      plugins,
      connections: [
        { name: "gh", plugin: "github", config: { token: "bundled" } },
      ],
    });
    const { error } = await codemode.execute(
      `return await github.search_issues({ query: "x" })`,
    );
    assert.match(error ?? "", /was made for a bundled or local plugin/);
  });

  it("closes a session no call has used for the idle time", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const events: McpEvent[] = [];
    const mcp = manager(
      { a: { command: "x" } },
      { a: server },
      {
        idleMs: 40,
        onEvent: (event) => events.push(event),
      },
    );
    await mcp.load();
    // The idle check runs every second at most often.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.ok(
      events.some(
        (event) => event.type === "state" && event.state === "closed",
      ),
    );
  });
});

describe("an HTTP server's session", () => {
  const ADDRESS = "https://tools.test/mcp";

  /**
   * A server over HTTP that names its session, as one that keeps state
   * does. `refuse` answers a request in the server's place.
   */
  function overHttp(refuse: (request: Request) => Response | undefined) {
    const server = fakeServer({
      tools: [SEARCH],
      resources: [{ uri: "note://1", name: "First", text: "hello" }],
    });
    const state = { session: "s1" };
    const http = fakeHttp(server, ADDRESS, refuse);
    const mcp = new McpManager({
      store: new MemoryMcpStore({ user: { tools: { url: ADDRESS } } }),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await http(input, init);
        if (response.ok) response.headers.set("mcp-session-id", state.session);
        return response;
      }) as typeof globalThis.fetch,
    });
    managers.push(mcp);
    const called = (method: string) =>
      server.received.filter((r) => r.method === method).length;
    return { server, state, mcp, called };
  }

  it("opens a new session and calls once when the server has forgotten the old one", async () => {
    const { state, mcp, called } = overHttp((request) => {
      const sent = request.headers.get("mcp-session-id");
      return sent && sent !== state.session
        ? new Response("unknown session", { status: 404 })
        : undefined;
    });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });
    const run = () =>
      codemode.execute(`return await tools.search_issues({ query: "x" })`);
    assert.equal((await run()).error, undefined);
    assert.equal(called("initialize"), 1);

    // The server restarts: it knows no session by the old name.
    state.session = "s2";
    assert.equal((await run()).error, undefined);
    assert.equal(called("initialize"), 2);
    assert.equal(called("tools/call"), 2);
  });

  it("tries a read again after a passing failure, and never a tool call", async () => {
    let failing = false;
    const { mcp, called } = overHttp((request) => {
      if (!failing || request.method !== "POST") return undefined;
      failing = false;
      return new Response("busy", { status: 503 });
    });
    const codemode = codemodeWith({ plugins: (await mcp.load()).plugins });

    failing = true;
    const read = await codemode.execute(
      `return (await tools.resources.list()).resources.length`,
    );
    assert.deepEqual(read, { result: 1, logs: [] });

    failing = true;
    const call = await codemode.execute(
      `return await tools.search_issues({ query: "x" })`,
    );
    assert.match(call.error ?? "", /status 503/);
    assert.equal(called("tools/call"), 0);
  });
});

describe("faults no call answers for", () => {
  it("reports what the client would drop, with the server's name", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    let opened: ReturnType<FakeServer["transport"]> | undefined;
    const events: McpEvent[] = [];
    const mcp = manager(
      { a: { command: "x" } },
      {
        a: {
          ...server,
          transport() {
            opened = server.transport();
            return opened;
          },
        },
      },
      { onEvent: (event) => events.push(event) },
    );
    await mcp.load();
    (opened as unknown as { emitError(error: Error): void }).emitError(
      new Error("Received a line that is not JSON"),
    );
    assert.deepEqual(
      events.filter((event) => event.type === "fault"),
      [
        {
          type: "fault",
          server: "a",
          message: "Received a line that is not JSON",
        },
      ],
    );
  });
});

describe("tool lists that change", () => {
  it("rewrites the cache and says so when the server announces a change", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const cache = new MemoryMcpToolCache();
    const mcp = manager({ a: { command: "x" } }, { a: server }, { cache });
    const changed: string[] = [];
    mcp.onToolsChanged((name) => changed.push(name));
    await mcp.load();
    assert.deepEqual(changed, []);

    server.options.tools = [SEARCH, DELETE];
    await server.notify("notifications/tools/list_changed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(changed, ["a"]);
    assert.equal((await cache.read("user", "a"))?.tools.length, 2);
    assert.equal((await mcp.load()).plugins[0].actions.length, 2);
  });

  it("is not disturbed by a listener that throws or rejects", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ a: { command: "x" } }, { a: server });
    const heard: string[] = [];
    mcp.onToolsChanged(() => {
      throw new Error("listener failed");
    });
    mcp.onToolsChanged(async () => {
      throw new Error("listener rejected");
    });
    mcp.onToolsChanged((name) => {
      heard.push(name);
    });
    await mcp.load();
    server.options.tools = [DELETE];
    assert.deepEqual((await mcp.refresh()).changed, ["a"]);
    assert.deepEqual(heard, ["a"]);
  });

  it("reads tool lists again on refresh, and names what changed", async () => {
    const a = fakeServer({ tools: [SEARCH] });
    const b = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ a: { command: "x" }, b: { command: "x" } }, { a, b });
    await mcp.load();
    b.options.tools = [DELETE];
    assert.deepEqual(await mcp.refresh(), {
      refreshed: ["a", "b"],
      changed: ["b"],
      problems: [],
    });
    assert.deepEqual((await mcp.refresh("b")).changed, []);
    await assert.rejects(
      mcp.refresh("missing"),
      /No MCP server named "missing"/,
    );
  });

  it("reads the other servers again when one cannot be reached", async () => {
    const b = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ down: { command: "x" }, b: { command: "x" } }, { b });
    await mcp.load();
    b.options.tools = [DELETE];
    const { refreshed, changed, problems } = await mcp.refresh();
    assert.deepEqual(refreshed, ["b"]);
    assert.deepEqual(changed, ["b"]);
    assert.deepEqual(
      problems.map((problem) => [problem.server, problem.code]),
      [["down", "connect_failed"]],
    );
    assert.match(problems[0].message, /MCP server "down" failed to connect/);
  });

  it("counts the tools an entry loads, not all the server offers", async () => {
    const server = fakeServer({ tools: [SEARCH, DELETE] });
    const mcp = manager(
      { a: { command: "x", tools: ["!delete_*"] } },
      { a: server },
    );
    assert.equal((await mcp.status())[0].tools, 1);
    assert.equal((await mcp.list())[0].cachedTools, 1);
  });

  it("swaps a server's plugin into a project instance when its tools change", async () => {
    const home = join(tmp, "home");
    const project = join(tmp, "project", ".codemode");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        connections: [],
        mcpServers: {
          fixture: { command: process.execPath, args: [STDIO_SERVER] },
        },
      }),
    );
    writeFileSync(
      join(project, "config.json"),
      JSON.stringify({ connections: [] }),
    );
    const codemode = await Codemode.fromProject(join(tmp, "project"), {
      userDir: home,
      builtinDir: join(tmp, "no-builtins"),
      packages: false,
    });
    assert.ok(codemode);
    instances.push(codemode);
    const [plugin] = codemode.plugins();
    assert.equal(plugin.sourceInfo?.origin, "mcp");
    assert.equal(plugin.description, "A fixture server.");
    assert.equal(plugin.actions.includes("grown"), false);
    // The tool list is kept in the folder that defines the server.
    assert.ok(existsSync(join(home, "mcp", "fixture.json")));

    const { error } = await codemode.execute(`return await fixture.grow()`);
    assert.equal(error, undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(codemode.plugins()[0].actions.includes("grown"));
    const { result } = await codemode.execute(
      `return actions.list("fixture").includes("fixture.grown")`,
    );
    assert.equal(result, true);
  });
});

describe("managing servers", () => {
  it("adds, lists and removes a server", async () => {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager({}, { "my-docs": server });
    const added = await mcp.add("my-docs", { url: "https://example.com/mcp" });
    assert.deepEqual(added, {
      name: "my-docs",
      plugin: "my_docs",
      scope: "user",
      source: "user MCP servers",
      transport: "http",
      enabled: true,
      target: "https://example.com/mcp",
    });
    await mcp.load();
    assert.equal((await mcp.list())[0].cachedTools, 1);
    assert.equal(await mcp.remove("my-docs"), true);
    assert.equal(await mcp.remove("my-docs"), false);
    assert.deepEqual(await mcp.list(), []);
  });

  it("refuses an invalid entry, a name already defined, and one that collides in code", async () => {
    const mcp = manager({ "a-b": { command: "x" } }, {});
    await assert.rejects(
      mcp.add("bad", { type: "sse", url: "https://example.com" }),
      (error) => isMcpServerError(error) && error.code === "invalid_config",
    );
    await assert.rejects(mcp.add("a-b", { command: "y" }), /already defined/);
    await assert.rejects(
      mcp.add("a_b", { command: "y" }),
      (error) => isMcpServerError(error) && error.code === "name_conflict",
    );
    await assert.rejects(
      mcp.add("p", { command: "y" }, { scope: "project" }),
      (error) => isMcpServerError(error) && error.code === "untrusted",
    );
  });

  it("reports each server's state", async () => {
    const mcp = manager(
      {
        up: { command: "x" },
        down: { command: "x" },
        off: { command: "x", enabled: false },
      },
      { up: fakeServer({ tools: [SEARCH, DELETE] }) },
    );
    const status = await mcp.status();
    assert.deepEqual(
      status.map((server) => [server.name, server.state, server.tools]),
      [
        ["up", "connected", 2],
        ["down", "failed", undefined],
        ["off", "disabled", undefined],
      ],
    );
    assert.match(status[1].error ?? "", /failed to connect/);
  });
});

describe("servers kept in codemode folders", () => {
  it("reads config.json and mcp.json, writes a new server to config.json and an edit where it is defined", async () => {
    const dir = join(tmp, ".codemode");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ connections: [], timeoutMs: 5 }),
    );
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "x" } }, other: 1 }),
    );
    const store = new FileMcpStore({ user: dir });
    const [config, mcp] = await store.read("user");
    assert.deepEqual(config.servers, {});
    assert.deepEqual(mcp.servers, { shared: { command: "x" } });
    assert.equal(config.base, tmp);
    assert.deepEqual(await store.read("project"), []);

    assert.equal(await store.write("user", "added", { command: "new" }), false);
    assert.equal(
      await store.write("user", "shared", { command: "edited" }),
      true,
    );
    const written = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(written.mcpServers, { added: { command: "new" } });
    assert.equal(written.timeoutMs, 5);
    const shared = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    assert.deepEqual(shared, {
      mcpServers: { shared: { command: "edited" } },
      other: 1,
    });

    assert.equal(await store.write("user", "added", undefined), true);
    assert.equal(
      "mcpServers" in
        JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
      false,
    );
    await assert.rejects(store.write("project", "x", {}), /No project folder/);
  });

  it("reports a malformed file as its own problem", async () => {
    const dir = join(tmp, ".codemode");
    mkdirSync(dir);
    writeFileSync(join(dir, "mcp.json"), "{ not json");
    const [, mcp] = await new FileMcpStore({ user: dir }).read("user");
    assert.equal(mcp.error, "malformed JSON");
    assert.deepEqual(mcp.servers, {});
  });

  it("keeps tool lists under the folder's mcp/ and ignores a damaged one", async () => {
    const cache = new FileMcpToolCache({ user: tmp });
    const snapshot = {
      key: "k",
      tools: [SEARCH],
      resources: false,
      savedAt: 1,
    };
    await cache.write("user", "a", snapshot);
    assert.deepEqual(await cache.read("user", "a"), snapshot);
    assert.equal(await cache.read("project", "a"), undefined);
    writeFileSync(join(tmp, "mcp", "a.json"), "{");
    assert.equal(await cache.read("user", "a"), undefined);
    await cache.remove("user", "a");
    assert.equal(existsSync(join(tmp, "mcp", "a.json")), false);
  });

  it("keeps each identity's tool list in a file of its own, and removes them with the server", async () => {
    const cache = new FileMcpToolCache({ user: tmp });
    const snapshot = {
      key: "k",
      tools: [SEARCH],
      resources: false,
      savedAt: 1,
    };
    await cache.write("user", "a", snapshot);
    await cache.write("user", "a", { ...snapshot, tools: [] }, "ann/../x");
    assert.equal((await cache.read("user", "a"))?.tools.length, 1);
    assert.equal((await cache.read("user", "a", "ann/../x"))?.tools.length, 0);
    assert.equal(await cache.read("user", "a", "bo"), undefined);
    assert.deepEqual(readdirSync(join(tmp, "mcp")).sort(), ["a", "a.json"]);
    assert.match(readdirSync(join(tmp, "mcp", "a"))[0], /^[0-9a-f]{32}\.json$/);
    await cache.remove("user", "a");
    assert.deepEqual(readdirSync(join(tmp, "mcp")), []);
  });
});

describe("a server and the bundled plugin of its name", () => {
  /** A bundled plugins folder with one plugin, `github`. */
  function builtins(): string {
    const dir = join(tmp, "builtins");
    mkdirSync(join(dir, "github"), { recursive: true });
    writeFileSync(
      join(dir, "github", "index.js"),
      `export default function (api) {
        api.setName("github");
        api.registerAction("bundled", { execute: () => "bundled" });
      }`,
    );
    return dir;
  }

  async function discover(
    connections: Array<{ plugin: string; owner?: string }>,
    all = false,
  ) {
    const server = fakeServer({ tools: [SEARCH] });
    const mcp = manager({ github: { command: "x" } }, { github: server });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const plugins = await discoverPlugins(null, {
        builtinDir: builtins(),
        builtinAllowlist: all ? null : enabledBuiltins(connections),
        enabledBuiltins: enabledBuiltins(connections),
        userDir: join(tmp, "home"),
        mcp,
      });
      return { plugins, errors };
    } finally {
      console.error = original;
    }
  }

  it("takes the name while the bundled plugin has no connection", async () => {
    const { plugins, errors } = await discover([]);
    assert.deepEqual(
      plugins.map((plugin) => [plugin.name, plugin.sourceInfo?.origin]),
      [["github", "mcp"]],
    );
    assert.deepEqual(errors, []);
  });

  it("keeps the name when its own connection is the only one", async () => {
    const { plugins, errors } = await discover([
      { plugin: "github", owner: "mcp:github" },
    ]);
    assert.equal(plugins[0].sourceInfo?.origin, "mcp");
    assert.deepEqual(errors, []);
  });

  it("is refused once a connection puts the bundled plugin in use", async () => {
    for (const owner of ["builtin", undefined]) {
      const { plugins, errors } = await discover([{ plugin: "github", owner }]);
      assert.deepEqual(
        plugins.map((plugin) => [plugin.name, plugin.sourceInfo?.origin]),
        [["github", "builtin"]],
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0], /MCP server "github".*was not loaded/);
      assert.match(errors[0], /Rename the server/);
    }
  });

  it("leaves the bundled plugin out, quietly, when every bundled plugin is listed", async () => {
    const { plugins, errors } = await discover([], true);
    assert.deepEqual(
      plugins.map((plugin) => [plugin.name, plugin.sourceInfo?.origin]),
      [["github", "mcp"]],
    );
    assert.deepEqual(errors, []);
  });
});

describe("a real server process", () => {
  it("starts on the first call, sees only its own environment, and ends when closed", async () => {
    const pidFile = join(tmp, "pid");
    const mcp = new McpManager({
      store: new MemoryMcpStore({
        user: {
          fixture: {
            command: process.execPath,
            args: [STDIO_SERVER, pidFile],
            env: { FIXTURE_FLAG: "on" },
          },
        },
      }),
      environment: { PATH: process.env.PATH },
    });
    managers.push(mcp);
    process.env.CODEMODE_TEST_HOST_SECRET = "must-not-leak";
    try {
      const { plugins, problems } = await mcp.load();
      assert.deepEqual(problems, []);
      assert.equal(plugins[0].description, "A fixture server.");
      const codemode = codemodeWith({ plugins });
      const { result, error } = await codemode.execute(`
        const echoed = await fixture.echo({ text: "hi" });
        const env = await fixture.env();
        let failure;
        try { await fixture.fail(); } catch (e) { failure = e.message; }
        return { echoed: echoed.structuredContent, names: env.structuredContent.names, failure };
      `);
      assert.equal(error, undefined);
      const found = result as {
        echoed: unknown;
        names: string[];
        failure: string;
      };
      assert.deepEqual(found.echoed, { text: "hi" });
      assert.equal(found.failure, "the tool said no");
      assert.ok(found.names.includes("FIXTURE_FLAG"));
      assert.ok(found.names.includes("PATH"));
      assert.equal(found.names.includes("CODEMODE_TEST_HOST_SECRET"), false);
      assert.equal(found.names.includes("HOME"), false);
    } finally {
      delete process.env.CODEMODE_TEST_HOST_SECRET;
    }
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.doesNotThrow(() => process.kill(pid, 0));
    await mcp.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0), "the server process ended");
  });

  it("names the server that died during a call, with what it printed", async () => {
    const mcp = new McpManager({
      store: new MemoryMcpStore({
        user: {
          fixture: {
            command: process.execPath,
            args: [STDIO_SERVER],
            env: { FIXTURE_FAULT: "crash" },
          },
        },
      }),
      environment: { PATH: process.env.PATH },
    });
    managers.push(mcp);
    const failures: unknown[] = [];
    const codemode = codemodeWith({
      plugins: (await mcp.load()).plugins,
      onAction: (info) => {
        failures.push(info.error);
      },
    });
    const { error } = await codemode.execute(
      `return await fixture.echo({ text: "hi" })`,
    );
    assert.match(
      error ?? "",
      /MCP server "fixture" closed the connection before it answered:\nfatal: out of disk/,
    );
    assert.ok(isMcpServerError(failures[0]));
    assert.equal(failures[0].code, "closed");
    // The next call starts the server again.
    assert.equal((await mcp.status())[0].state, "connected");
  });

  it("reports a command that cannot be started, with what it printed", async () => {
    const mcp = new McpManager({
      store: new MemoryMcpStore({
        user: {
          missing: { command: join(tmp, "no-such-command") },
          crashes: {
            command: process.execPath,
            args: ["-e", "console.error('bad flag --x'); process.exit(2)"],
          },
        },
      }),
      environment: { PATH: process.env.PATH },
    });
    managers.push(mcp);
    const { problems } = await mcp.load();
    const byServer = Object.fromEntries(
      problems.map((problem) => [problem.server, problem.message]),
    );
    assert.match(byServer.missing, /failed to connect/);
    assert.match(byServer.crashes, /bad flag --x/);
  });
});
