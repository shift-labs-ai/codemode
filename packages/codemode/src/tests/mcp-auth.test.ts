/**
 * Signing in to an MCP server through codemode's credential layer. The
 * server, its protected-resource metadata, its authorization server and
 * the token endpoint are all one fake `fetch`: no request leaves the test.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Tool } from "@earendil-works/pi-mcp";
import { exchangeOAuth2Code } from "../auth/oauth2.js";
import { MemoryConnectionProvider } from "../connections/memory.js";
import {
  MCP_GRANT_FIELD,
  MCP_OAUTH_FIELD,
  type McpOAuthSetup,
  mcpOAuthConnection,
} from "../mcp/auth.js";
import { MemoryMcpToolCache } from "../mcp/cache.js";
import { isMcpServerError } from "../mcp/errors.js";
import { McpManager } from "../mcp/manager.js";
import { MemoryMcpStore } from "../mcp/store.js";
import type { ConnectionConfig } from "../plugin/types.js";
import { Codemode } from "../sdk.js";
import { fakeHttp, fakeServer, placeholder } from "./helpers/mcp-server.js";

const SERVER = "https://mcp.test/mcp";
const REDIRECT = "http://127.0.0.1:47823/callback";
const WHOAMI: Tool = { name: "whoami", inputSchema: { type: "object" } };

const managers: McpManager[] = [];
const instances: Codemode[] = [];
afterEach(async () => {
  for (const codemode of instances.splice(0)) codemode.dispose();
  for (const manager of managers.splice(0)) await manager.close();
});

/**
 * An MCP server that wants a bearer, with an authorization server that
 * registers clients and issues `access-<n>` tokens, each good until
 * `revoke()`.
 */
function world(
  options: { registration?: boolean; refuseRefresh?: boolean } = {},
) {
  const server = fakeServer({
    tools: [WHOAMI],
    call: () => ({ content: [{ type: "text", text: "you" }] }),
  });
  const valid = new Set<string>();
  const requests: Array<{ url: string; body: URLSearchParams | unknown }> = [];
  let issued = 0;
  const issue = () => {
    const token = `access-${++issued}`;
    valid.add(token);
    return token;
  };
  const mcp = fakeHttp(server, SERVER, (request) => {
    const bearer = request.headers
      .get("authorization")
      ?.replace(/^Bearer /, "");
    if (bearer && valid.has(bearer)) return undefined;
    return new Response("unauthorized", {
      status: 401,
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="read"',
      },
    });
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SERVER) return mcp(input, init);
    if (url === "https://mcp.test/.well-known/oauth-protected-resource/mcp")
      return Response.json({
        resource: SERVER,
        authorization_servers: ["https://auth.test"],
        scopes_supported: ["read", "write"],
      });
    if (url === "https://auth.test/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: "https://auth.test",
        authorization_endpoint: "https://auth.test/authorize",
        token_endpoint: "https://auth.test/token",
        ...(options.registration === false
          ? {}
          : { registration_endpoint: "https://auth.test/register" }),
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
        authorization_response_iss_parameter_supported: true,
      });
    if (url === "https://auth.test/register") {
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body });
      return Response.json({
        client_id: "registered-client",
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: "none",
      });
    }
    if (url === "https://auth.test/token") {
      const body = new URLSearchParams(String(init?.body));
      requests.push({ url, body });
      if (
        body.get("grant_type") === "refresh_token" &&
        (options.refuseRefresh || body.get("refresh_token") !== "refresh-1")
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: issue(),
        token_type: "Bearer",
        refresh_token: "refresh-1",
        expires_in: 3600,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  const connections = new MemoryConnectionProvider();
  const cache = new MemoryMcpToolCache();
  const manager = (entry: Record<string, unknown> = { url: SERVER }) => {
    const created = new McpManager({
      store: new MemoryMcpStore({ user: { srv: entry } }),
      cache,
      connections,
      fetch,
      variable: (name) => (name === "CLIENT_SECRET" ? "s3cret" : undefined),
    });
    managers.push(created);
    return created;
  };
  return {
    server,
    fetch,
    requests,
    connections,
    manager,
    tokenRequests: () =>
      requests
        .filter((request) => request.url === "https://auth.test/token")
        .map((request) => request.body as URLSearchParams),
    revoke: () => valid.clear(),
    /** Sign in: exchange a code and store the result as the server's connection. */
    async signIn(setup: McpOAuthSetup): Promise<void> {
      const tokens = await exchangeOAuth2Code(
        setup.definition,
        {
          application: setup.application,
          code: "the-code",
          redirectUri: setup.redirectUri,
          codeVerifier: "v".repeat(43),
        },
        { fetch },
      );
      const handle = await connections.resolve({
        plugin: "srv",
        owner: "mcp:srv",
      });
      await handle.update(mcpOAuthConnection(setup, tokens));
    },
    connection: (): ConnectionConfig => connections.list()[0],
  };
}

async function call(manager: McpManager, w: ReturnType<typeof world>) {
  const { plugins, problems } = await manager.load();
  const codemode = Codemode.create({
    plugins,
    connectionProvider: w.connections,
  });
  instances.push(codemode);
  return {
    problems,
    run: () => codemode.execute(`return (await srv.whoami()).content[0].text`),
  };
}

describe("finding how to sign in to an MCP server", () => {
  it("discovers the endpoints, registers a client, and answers an OAuth2 definition", async () => {
    const w = world();
    const setup = await w.manager().oauth("srv", { redirectUri: REDIRECT });
    assert.deepEqual(setup, {
      definition: {
        id: "mcp",
        provider: "mcp",
        authorization: {
          url: "https://auth.test/authorize",
          parameters: { resource: SERVER },
        },
        exchange: {
          url: "https://auth.test/token",
          clientAuthentication: "client_id",
          parameters: { resource: SERVER },
          requirePkce: true,
        },
        refresh: {
          url: "https://auth.test/token",
          clientAuthentication: "client_id",
          parameters: { resource: SERVER },
        },
      },
      application: { clientId: "registered-client" },
      // The server's challenge asked for `read`; its metadata lists more.
      scopes: ["read"],
      redirectUri: REDIRECT,
      issuer: "https://auth.test",
      issuerRequired: true,
    });
    const [registration] = w.requests;
    assert.deepEqual(registration.body, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "codemode",
      application_type: "native",
      scope: "read",
    });
  });

  it("signs in as the client an entry names, with its secret and its redirect", async () => {
    const w = world();
    const setup = await w
      .manager({
        url: SERVER,
        oauth: {
          clientId: "configured",
          clientSecret: placeholder("CLIENT_SECRET"),
          callbackPort: 9123,
          scope: "write admin",
        },
      })
      .oauth("srv", { redirectUri: REDIRECT });
    assert.deepEqual(setup.application, {
      clientId: "configured",
      clientSecret: "s3cret",
    });
    assert.equal(setup.redirectUri, "http://127.0.0.1:9123/callback");
    assert.deepEqual(setup.scopes, ["write", "admin"]);
    assert.equal(
      setup.definition.exchange?.clientAuthentication,
      "client_secret_basic",
    );
    assert.equal(w.requests.length, 0);
  });

  it("says what is missing when the server cannot be signed in to", async () => {
    const unsupported = (error: unknown) =>
      isMcpServerError(error) && error.code === "sign_in_unsupported";
    await assert.rejects(
      world({ registration: false })
        .manager()
        .oauth("srv", { redirectUri: REDIRECT }),
      (error) =>
        unsupported(error) && /set "oauth\.clientId"/.test(String(error)),
    );
    await assert.rejects(
      world()
        .manager({ url: SERVER, headers: { Authorization: "Bearer x" } })
        .oauth("srv", { redirectUri: REDIRECT }),
      (error) =>
        unsupported(error) && /its own Authorization/.test(String(error)),
    );
    await assert.rejects(
      world().manager({ command: "x" }).oauth("srv", { redirectUri: REDIRECT }),
      (error) => unsupported(error) && /only HTTP servers/.test(String(error)),
    );
    await assert.rejects(
      world().manager().oauth("other", { redirectUri: REDIRECT }),
      /No MCP server named "other"/,
    );
  });
});

describe("a signed-in MCP server", () => {
  it("is asked to sign in before anything is stored, and says how", async () => {
    const w = world();
    const mcp = w.manager();
    const { problems } = await mcp.load();
    assert.equal(problems[0].code, "reconnect_required");
    assert.equal(
      problems[0].message,
      'MCP server "srv" requires sign-in. Run `codemode auth srv`.',
    );
    assert.equal((await mcp.status())[0].state, "needs_sign_in");
  });

  it("keeps the client and a revisioned grant in the connection, and calls with its token", async () => {
    const w = world();
    const mcp = w.manager();
    const setup = await mcp.oauth("srv", { redirectUri: REDIRECT });
    await w.signIn(setup);

    const [exchange] = w.tokenRequests();
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.equal(exchange.get("client_id"), "registered-client");
    assert.equal(exchange.get("resource"), SERVER);
    assert.equal(exchange.get("code_verifier"), "v".repeat(43));

    const stored = w.connection().config;
    assert.deepEqual(stored[MCP_OAUTH_FIELD], {
      definition: setup.definition,
      clientId: "registered-client",
      scopes: ["read"],
    });
    const grant = stored[MCP_GRANT_FIELD] as {
      tokens: Record<string, unknown>;
      revision: string;
    };
    assert.equal(grant.tokens.accessToken, "access-1");
    assert.equal(grant.tokens.refreshToken, "refresh-1");
    assert.equal(grant.tokens.scope, "read");
    assert.ok(grant.revision);

    const { problems, run } = await call(mcp, w);
    assert.deepEqual(problems, []);
    assert.deepEqual(await run(), { result: "you", logs: [] });
    assert.equal(w.tokenRequests().length, 1);
  });

  it("renews a stale token once for calls made together, and stores it", async () => {
    const w = world();
    const mcp = w.manager();
    await w.signIn(await mcp.oauth("srv", { redirectUri: REDIRECT }));
    const { plugins } = await mcp.load();
    const codemode = Codemode.create({
      plugins,
      connectionProvider: w.connections,
    });
    instances.push(codemode);

    // The stored token now ends in 30 seconds: inside the margin it is renewed at.
    type Grant = { revision: string; tokens: Record<string, unknown> };
    const handle = await w.connections.resolve({
      plugin: "srv",
      owner: "mcp:srv",
    });
    await handle.update((current) => {
      const grant = current[MCP_GRANT_FIELD] as Grant;
      return {
        [MCP_GRANT_FIELD]: {
          revision: "stale",
          tokens: { ...grant.tokens, expiresAt: Date.now() + 30_000 },
        },
      };
    });

    const { result, error } = await codemode.execute(
      `return (await Promise.all([srv.whoami(), srv.whoami(), srv.whoami()])).length`,
    );
    assert.equal(error, undefined);
    assert.equal(result, 3);
    const refreshes = w
      .tokenRequests()
      .filter((body) => body.get("grant_type") === "refresh_token");
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].get("refresh_token"), "refresh-1");
    assert.equal(refreshes[0].get("resource"), SERVER);
    assert.equal(refreshes[0].get("client_id"), "registered-client");
    const after = w.connection().config[MCP_GRANT_FIELD] as Grant;
    assert.notEqual(after.revision, "stale");
    assert.equal(after.tokens.accessToken, "access-2");
    assert.equal(after.tokens.scope, "read");
  });

  it("renews a token the server refuses, and repeats the request", async () => {
    const w = world();
    const mcp = w.manager();
    await w.signIn(await mcp.oauth("srv", { redirectUri: REDIRECT }));
    const { run } = await call(mcp, w);
    assert.equal((await run()).result, "you");
    w.revoke();
    assert.deepEqual(await run(), { result: "you", logs: [] });
    const grant = w.connection().config[MCP_GRANT_FIELD] as {
      tokens: { accessToken: string };
    };
    assert.equal(grant.tokens.accessToken, "access-2");
  });

  it("asks for sign-in again when the grant can no longer be renewed", async () => {
    const w = world({ refuseRefresh: true });
    const mcp = w.manager();
    await w.signIn(await mcp.oauth("srv", { redirectUri: REDIRECT }));
    const { run } = await call(mcp, w);
    assert.equal((await run()).result, "you");
    w.revoke();
    const { error } = await run();
    assert.match(
      error ?? "",
      /MCP server "srv" needs you to sign in again\. Run `codemode auth srv`\./,
    );
    assert.equal((await mcp.status())[0].state, "needs_sign_in");
  });

  it("tells a host's own sign-in hint instead of the command line's", async () => {
    const w = world();
    const mcp = new McpManager({
      store: new MemoryMcpStore({ user: { srv: { url: SERVER } } }),
      fetch: w.fetch,
      signInHint: (server) => `Connect ${server} in Settings.`,
    });
    managers.push(mcp);
    assert.equal(
      (await mcp.load()).problems[0].message,
      'MCP server "srv" requires sign-in. Connect srv in Settings.',
    );
  });

  it("reports a refused static credential as the entry's own, not as a sign-in", async () => {
    const w = world();
    const mcp = w.manager({
      url: SERVER,
      headers: { Authorization: "Bearer stale" },
    });
    const { problems } = await mcp.load();
    assert.equal(problems[0].code, "reconnect_required");
    assert.match(
      problems[0].message,
      /refused the credentials its entry sends \(HTTP 401\)/,
    );
  });
});
