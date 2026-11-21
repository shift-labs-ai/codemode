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
import { McpManager, type McpManagerOptions } from "../mcp/manager.js";
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
  options: {
    registration?: boolean;
    refuseRefresh?: boolean;
    /** Where the MCP server is. Default: `SERVER`. */
    server?: string;
    /** The authorization server's issuer. Default: `https://auth.test`. */
    issuer?: string;
    /** Whether the authorization server takes Client ID Metadata Documents. */
    documents?: boolean;
    /** Whether its responses carry `iss`. Default: true. */
    iss?: boolean;
    manager?: Partial<McpManagerOptions>;
  } = {},
) {
  const address = options.server ?? SERVER;
  const issuer = options.issuer ?? "https://auth.test";
  const resourceMetadata = `${new URL(address).origin}/.well-known/oauth-protected-resource/mcp`;
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
  const mcp = fakeHttp(server, address, (request) => {
    const bearer = request.headers
      .get("authorization")
      ?.replace(/^Bearer /, "");
    if (bearer && valid.has(bearer)) return undefined;
    return new Response("unauthorized", {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${resourceMetadata}", scope="read"`,
      },
    });
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === address) return mcp(input, init);
    if (url === resourceMetadata)
      return Response.json({
        resource: address,
        authorization_servers: [issuer],
        scopes_supported: ["read", "write"],
      });
    if (url === `${issuer}/.well-known/oauth-authorization-server`)
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(options.registration === false
          ? {}
          : { registration_endpoint: `${issuer}/register` }),
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
        authorization_response_iss_parameter_supported: options.iss !== false,
        ...(options.documents
          ? { client_id_metadata_document_supported: true }
          : {}),
      });
    if (url === `${issuer}/register`) {
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body });
      return Response.json({
        client_id: "registered-client",
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: "none",
      });
    }
    if (url === `${issuer}/token`) {
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
  const manager = (entry: Record<string, unknown> = { url: address }) => {
    const created = new McpManager({
      store: new MemoryMcpStore({ user: { srv: entry } }),
      cache,
      connections,
      fetch,
      variable: (name) => (name === "CLIENT_SECRET" ? "s3cret" : undefined),
      ...options.manager,
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
        .filter((request) => request.url === `${issuer}/token`)
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

describe("the client a sign-in uses", () => {
  /** A host's documents, which list `/callback` on 127.0.0.1 at any port. */
  const documents = {
    baseUrl: "https://client.test/oauth",
    listsRedirectUrl: (redirectUrl: string) => {
      const url = new URL(redirectUrl);
      return url.hostname === "127.0.0.1" && url.pathname === "/callback";
    },
  };
  const hosted = { manager: { clientMetadataDocuments: documents } };
  const registrations = (w: ReturnType<typeof world>) =>
    w.requests.filter((request) => request.url.endsWith("/register")).length;

  it("is the host's document where the authorization server takes one, and nothing is registered", async () => {
    const w = world({ ...hosted, documents: true });
    const setup = await w.manager().oauth("srv", { redirectUri: REDIRECT });
    assert.deepEqual(setup.application, {
      clientId: "https://client.test/oauth/client.json",
    });
    assert.equal(setup.redirectUri, REDIRECT);
    assert.equal(setup.definition.exchange?.clientAuthentication, "client_id");
    assert.equal(registrations(w), 0);
  });

  it("is a document and a redirect of the server's own when responses carry no issuer", async () => {
    const w = world({ ...hosted, documents: true, iss: false });
    const setup = await w.manager().oauth("srv", { redirectUri: REDIRECT });
    const id =
      /^https:\/\/client\.test\/oauth\/([\w-]{12})\/client\.json$/.exec(
        setup.application.clientId,
      )?.[1];
    assert.ok(id, setup.application.clientId);
    assert.equal(setup.redirectUri, `${REDIRECT}/${id}`);
    assert.equal(setup.issuerRequired, false);
    // Another server gets another document.
    const other = world({
      ...hosted,
      documents: true,
      iss: false,
      server: "https://other.test/mcp",
    });
    const second = await other
      .manager()
      .oauth("srv", { redirectUri: REDIRECT });
    assert.notEqual(second.application.clientId, setup.application.clientId);
  });

  it("is registered where the server takes no document, the documents do not list the redirect, or the entry says so", async () => {
    const unsupported = world(hosted);
    await unsupported.manager().oauth("srv", { redirectUri: REDIRECT });
    assert.equal(registrations(unsupported), 1);

    const unlisted = world({ ...hosted, documents: true });
    await unlisted
      .manager()
      .oauth("srv", { redirectUri: "http://127.0.0.1:47823/elsewhere" });
    assert.equal(registrations(unlisted), 1);

    const asked = world({ ...hosted, documents: true });
    const setup = await asked
      .manager({ url: SERVER, oauth: { clientRegistration: "dcr" } })
      .oauth("srv", { redirectUri: REDIRECT });
    assert.equal(setup.application.clientId, "registered-client");
  });

  it("refuses an entry that asks for a document the host or the server cannot give", async () => {
    const entry = { url: SERVER, oauth: { clientRegistration: "cimd" } };
    const { problems } = await world().manager(entry).load();
    assert.equal(problems[0].code, "invalid_config");
    assert.match(problems[0].message, /no Client ID Metadata Documents/);

    await assert.rejects(
      world(hosted).manager(entry).oauth("srv", { redirectUri: REDIRECT }),
      (error) =>
        isMcpServerError(error) &&
        error.code === "sign_in_unsupported" &&
        /takes no client metadata document/.test(error.message),
    );
    const bad = await world(hosted)
      .manager({
        url: SERVER,
        oauth: {
          clientRegistration: "cimd",
          callbackUrl: "http://127.0.0.1/other",
        },
      })
      .load();
    assert.match(
      bad.problems[0].message,
      /callbackUrl that the client metadata documents list/,
    );
  });
});

describe("signing in over http", () => {
  const LOCAL = "http://127.0.0.1:8931/mcp";
  const local = { server: LOCAL, issuer: "http://localhost:9000" };

  it("works for a server and an authorization server on this machine", async () => {
    const w = world(local);
    const mcp = w.manager();
    const setup = await mcp.oauth("srv", { redirectUri: REDIRECT });
    assert.equal(setup.definition.exchange?.url, "http://localhost:9000/token");
    await w.signIn(setup);
    const { problems, run } = await call(mcp, w);
    assert.deepEqual(problems, []);
    assert.deepEqual(await run(), { result: "you", logs: [] });
    // And the token is renewed there.
    w.revoke();
    assert.equal((await run()).result, "you");
  });

  it("is refused by a host that signs in over https only", async () => {
    const w = world({ ...local, manager: { signInOverHttp: "never" } });
    await assert.rejects(
      w.manager().oauth("srv", { redirectUri: REDIRECT }),
      (error) =>
        isMcpServerError(error) &&
        error.code === "sign_in_unsupported" &&
        /http:\/\/127\.0\.0\.1:8931\/mcp is reached over http\. Sign-in needs https\./.test(
          error.message,
        ),
    );
    assert.equal(w.requests.length, 0);
  });

  it("is refused for a server or an authorization server elsewhere, before a client is registered", async () => {
    for (const elsewhere of [
      { server: "http://mcp.test/mcp" },
      { issuer: "http://auth.test" },
    ]) {
      const w = world(elsewhere);
      await assert.rejects(
        w.manager().oauth("srv", { redirectUri: REDIRECT }),
        (error) =>
          isMcpServerError(error) &&
          error.code === "sign_in_unsupported" &&
          /Sign-in needs https, or a server on this machine\./.test(
            error.message,
          ),
      );
      assert.equal(w.requests.length, 0);
    }
  });
});

describe("asking a server that does not answer how to sign in", () => {
  /** A server whose requests wait until they are abandoned; nothing else exists. */
  function silent(options: { connectTimeoutMs?: number } = {}) {
    const mcp = new McpManager({
      store: new MemoryMcpStore({ user: { srv: { url: SERVER } } }),
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        String(input) === SERVER
          ? new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal?.reason),
              );
            })
          : Promise.resolve(
              new Response("not found", { status: 404 }),
            )) as typeof globalThis.fetch,
      ...options,
    });
    managers.push(mcp);
    return mcp;
  }

  it("stops when its caller gives up", async () => {
    const giveUp = new AbortController();
    const asked = silent().oauth("srv", {
      redirectUri: REDIRECT,
      signal: giveUp.signal,
    });
    setTimeout(() => giveUp.abort(), 20);
    await assert.rejects(asked, { name: "AbortError" });
    await assert.rejects(
      silent().oauth("srv", {
        redirectUri: REDIRECT,
        signal: AbortSignal.abort(),
      }),
      { name: "AbortError" },
    );
  });

  it("waits for it no longer than for any connect", async () => {
    const started = Date.now();
    await assert.rejects(
      silent({ connectTimeoutMs: 50 }).oauth("srv", { redirectUri: REDIRECT }),
      (error) =>
        isMcpServerError(error) && error.code === "sign_in_unsupported",
    );
    assert.ok(Date.now() - started < 5_000);
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
