/**
 * The command line with MCP servers. Each case runs the real command in
 * its own process, with its own home folder, against the stdio server of
 * `helpers/mcp-stdio-server.mjs`.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serverConnection } from "../commands/auth.js";
import { placeholder } from "./helpers/mcp-server.js";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
const STDIO_SERVER = fileURLToPath(
  new URL("./helpers/mcp-stdio-server.mjs", import.meta.url),
);

describe("the connection a sign-in is saved in", () => {
  const server = { name: "my-tools", plugin: "my_tools" };
  const connection = (name: string, owner?: string) => ({
    name,
    plugin: "my_tools",
    config: {},
    ...(owner === undefined ? {} : { owner }),
  });

  it("is the one the server already uses, whatever it is named", () => {
    assert.equal(
      serverConnection(
        [connection("other", "npm:x"), connection("tools", "mcp:my-tools")],
        server,
      )?.name,
      "tools",
    );
  });

  it("is none of those made for something else of the same name", () => {
    assert.equal(
      serverConnection(
        [connection("bundled"), connection("pkg", "npm:x")],
        server,
      ),
      undefined,
    );
    assert.equal(serverConnection([], server), undefined);
  });
});

describe("the command line with MCP servers", () => {
  let tmp: string;
  let home: string;
  let project: string;
  let pidFile: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "codemode-mcp-cli-")));
    home = join(tmp, "home");
    project = join(tmp, "project");
    pidFile = join(tmp, "pid");
    mkdirSync(join(project, ".codemode"), { recursive: true });
    mkdirSync(home);
    writeFileSync(
      join(project, ".codemode", "config.json"),
      JSON.stringify({ connections: [] }),
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function codemode(args: string[]) {
    const run = promisify(execFile)(process.execPath, [MAIN, ...args], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        CODEMODE_TEST_HOST_SECRET: "must-not-leak",
      },
      timeout: 30_000,
    });
    return run.then(
      (done) => ({ ...done, code: 0 }),
      (error) => error as { stdout: string; stderr: string; code: number },
    );
  }

  const userConfig = () =>
    JSON.parse(readFileSync(join(home, ".codemode", "config.json"), "utf8"));
  const projectConfig = () =>
    JSON.parse(readFileSync(join(project, ".codemode", "config.json"), "utf8"));

  const addFixture = (...flags: string[]) =>
    codemode([
      "mcp",
      "add",
      "my-tools",
      ...flags,
      "--",
      process.execPath,
      STDIO_SERVER,
      pidFile,
    ]);

  function serverRunning(): boolean {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), 0);
      return true;
    } catch {
      return false;
    }
  }

  it("adds a server, calls its tools from code, and leaves no process behind", async () => {
    const added = await addFixture("--env", "FLAG=a=b");
    assert.equal(added.code, 0, added.stderr);
    assert.match(
      added.stdout,
      /Added MCP server my-tools \(user\), in code as my_tools: connected, 4 tool\(s\)/,
    );
    assert.ok(existsSync(join(home, ".codemode", "mcp", "my-tools.json")));
    assert.deepEqual(userConfig().mcpServers, {
      "my-tools": {
        command: process.execPath,
        args: [STDIO_SERVER, pidFile],
        env: { FLAG: "a=b" },
      },
    });

    const ran = await codemode([
      "exec",
      "--json",
      `const echoed = await my_tools.echo({ text: "hi" });
       const env = await my_tools.env();
       return { echoed: echoed.structuredContent, names: env.structuredContent.names };`,
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    const { result } = JSON.parse(ran.stdout);
    assert.deepEqual(result.echoed, { text: "hi" });
    assert.ok(result.names.includes("FLAG"));
    assert.equal(result.names.includes("CODEMODE_TEST_HOST_SECRET"), false);
    assert.ok(existsSync(join(home, ".codemode", "mcp", "my-tools.json")));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(serverRunning(), false);
  });

  it("warns of a server that prints what is not JSON-RPC, and still returns the result", async () => {
    await addFixture("--env", "FIXTURE_FAULT=garble");
    const ran = await codemode([
      "exec",
      `return (await my_tools.echo({ text: "hi" })).content[0].text`,
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), "hi");
    assert.match(ran.stderr, /MCP server "my-tools": /);
  });

  it("exits with status 1 when a tool fails, after its server is closed", async () => {
    await addFixture();
    const ran = await codemode(["exec", "return await my_tools.fail()"]);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /the tool said no/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(serverRunning(), false);
  });

  it("lists servers with their state, and exits with status 1 when one is down", async () => {
    await addFixture();
    const up = await codemode(["mcp", "list"]);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /my-tools connected, 4 tool\(s\) \(user, stdio: /);

    const down = await codemode([
      "mcp",
      "add",
      "down",
      "--",
      join(tmp, "no-such-command"),
    ]);
    assert.equal(down.code, 0, down.stderr);
    assert.match(
      down.stdout,
      /Added MCP server down \(user\), in code as down: failed/,
    );
    assert.match(down.stderr, /"down" failed to connect/);
    const mixed = await codemode(["mcp", "list", "--json"]);
    assert.equal(mixed.code, 1);
    const states = Object.fromEntries(
      JSON.parse(mixed.stdout).map((s: { name: string; state: string }) => [
        s.name,
        s.state,
      ]),
    );
    assert.deepEqual(states, { "my-tools": "connected", down: "failed" });
  });

  it("shows a server's tools among the actions and the server among the plugins", async () => {
    await addFixture();
    const actions = await codemode(["actions"]);
    assert.match(actions.stdout, /my_tools\.echo \[read\] \(text: string\)/);
    assert.match(actions.stdout, /my_tools\.fail \[write\]/);
    const connected = await codemode(["actions", "--connected", "--json"]);
    assert.deepEqual(
      [
        ...new Set(
          JSON.parse(connected.stdout).map(
            (action: { plugin: string }) => action.plugin,
          ),
        ),
      ],
      ["my_tools"],
    );
    const plugins = await codemode(["plugin", "list", "--json"]);
    const found = JSON.parse(plugins.stdout).find(
      (plugin: { name: string }) => plugin.name === "my_tools",
    );
    assert.equal(found.origin, "mcp");
    assert.equal(found.actions.length, 4);
  });

  it("reads tool lists again on refresh", async () => {
    await addFixture();
    const refreshed = await codemode(["mcp", "refresh"]);
    assert.equal(refreshed.code, 0, refreshed.stderr);
    assert.match(refreshed.stdout, /nothing changed/);
    const missing = await codemode(["mcp", "refresh", "nope"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No MCP server named "nope"/);
  });

  it("removes a server and its cached tool list", async () => {
    await addFixture();
    await codemode(["mcp", "list"]);
    const cached = join(home, ".codemode", "mcp", "my-tools.json");
    assert.ok(existsSync(cached));
    const removed = await codemode(["mcp", "remove", "my-tools"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal("mcpServers" in userConfig(), false);
    assert.equal(existsSync(cached), false);
    const again = await codemode(["mcp", "remove", "my-tools"]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /No user MCP server is named my-tools/);
  });

  it("records a project's server with --local and trusts the project", async () => {
    const added = await addFixture("--local");
    assert.equal(added.code, 0, added.stderr);
    assert.ok(projectConfig().mcpServers["my-tools"]);
    const ran = await codemode([
      "exec",
      `return (await my_tools.echo({ text: "x" })).content[0].text`,
    ]);
    assert.equal(ran.stdout.trim(), "x");

    const revoked = await codemode(["trust", "--revoke"]);
    assert.equal(revoked.code, 0, revoked.stderr);
    const untrusted = await codemode(["exec", "return typeof my_tools"]);
    assert.match(untrusted.stderr, /1 MCP server\(s\).*not trusted/);
    assert.equal(serverRunning(), false);
  });

  it("reads a server from mcp.json, in the shape other MCP clients write", async () => {
    mkdirSync(join(home, ".codemode"));
    writeFileSync(
      join(home, ".codemode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: process.execPath, args: [STDIO_SERVER] },
        },
      }),
    );
    const ran = await codemode([
      "exec",
      `return (await shared.echo({ text: "from mcp.json" })).content[0].text`,
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), "from mcp.json");
  });

  it("fills a placeholder from the server's connection, bound to the server", async () => {
    const added = await addFixture(
      "--env",
      `SECRET_FLAG=${placeholder("flag")}`,
    );
    assert.equal(added.code, 0, added.stderr);
    const missing = await codemode(["exec", "return await my_tools.env()"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /env\.SECRET_FLAG needs "flag"/);

    const connected = await codemode([
      "connection",
      "add",
      "tools",
      "--plugin",
      "my-tools",
      "--set",
      "flag=on",
      "--json",
    ]);
    // Named as configured; recorded under the name code uses.
    assert.deepEqual(JSON.parse(connected.stdout), {
      ok: true,
      name: "tools",
      plugin: "my_tools",
      owner: "mcp:my-tools",
    });
    const ran = await codemode([
      "exec",
      "--json",
      "return (await my_tools.env()).structuredContent.names",
    ]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.ok(JSON.parse(ran.stdout).result.includes("SECRET_FLAG"));
  });

  it("refuses bad input to mcp add with what to type instead", async () => {
    const neither = await codemode(["mcp", "add", "x"]);
    assert.equal(neither.code, 1);
    assert.match(
      neither.stderr,
      /Give either --url <url> or a command after --/,
    );
    const both = await codemode([
      "mcp",
      "add",
      "x",
      "--url",
      "https://e.com/mcp",
      "--",
      "cmd",
    ]);
    assert.equal(both.code, 1);
    const header = await codemode([
      "mcp",
      "add",
      "x",
      "--header",
      "A=b",
      "--",
      "cmd",
    ]);
    assert.match(header.stderr, /--header applies to --url/);
    const twice = [await addFixture(), await addFixture()][1];
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /already defined/);
    const badUrl = await codemode([
      "mcp",
      "add",
      "old",
      "--url",
      "ftp://e.com/mcp",
      "--json",
    ]);
    assert.equal(JSON.parse(badUrl.stdout).code, "invalid_config");
  });

  it("says a stdio server has nothing to sign in to", async () => {
    await addFixture();
    const signedIn = await codemode(["auth", "my-tools"]);
    assert.equal(signedIn.code, 1);
    assert.match(
      signedIn.stderr,
      /cannot be signed in to: only HTTP servers use OAuth/,
    );
  });
});
