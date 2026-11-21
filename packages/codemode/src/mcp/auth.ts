import { createHash, randomUUID } from "node:crypto";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import type { McpClientMetadataDocuments } from "@earendil-works/pi-mcp/oauth";
import * as t from "typebox";
import { AuthError } from "../auth/errors.js";
import { isLoopbackHost } from "../auth/token.js";
import type {
  OAuth2Definition,
  OAuth2TokenEndpoint,
  OAuthApplication,
  OAuthTokens,
} from "../auth/types.js";
import type { ConnectionHandle } from "../connections/types.js";
import {
  CredentialRegistry,
  OAuthGrantSchema,
} from "../credentials/registry.js";
import { CredentialTransport } from "../credentials/transport.js";
import { isRecord, type McpServer } from "./config.js";
import { McpServerError } from "./errors.js";

/** The connection field holding a server's OAuth client and endpoints. */
export const MCP_OAUTH_FIELD = "mcpOAuth";
/** The connection field holding the grant: tokens and a revision. */
export const MCP_GRANT_FIELD = "mcpGrant";

const CREDENTIAL_TYPE = "mcp";
const CREDENTIAL_METHOD = "oauth";

/**
 * What a sign-in to an MCP server needs, found by discovery: the endpoints
 * as an OAuth2 definition, the client to sign in as, and what to check on
 * the way back. A bundled OAuth plugin declares the same values in code.
 */
export interface McpOAuthSetup {
  definition: OAuth2Definition;
  application: OAuthApplication;
  scopes: string[];
  /**
   * The redirect URI to sign in with: the caller's or the entry's, with the
   * server's own path when the client is a server-specific document.
   */
  redirectUri: string;
  /** The authorization server's issuer, to compare the callback's `iss` with. */
  issuer: string;
  /** Whether the callback must carry `iss` (RFC 9207). */
  issuerRequired: boolean;
}

/** What `MCP_OAUTH_FIELD` holds. */
interface StoredOAuth {
  definition: OAuth2Definition;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
}

/**
 * A host's Client ID Metadata Documents: `<baseUrl>/client.json`, and
 * `<baseUrl>/<callback ID>/client.json` per server, as pi and Codex lay
 * theirs out. `listsRedirectUrl` says whether they list a redirect URI.
 */
export type { McpClientMetadataDocuments };

/** Which servers may be signed in to over http: ones on this machine, or none. */
export type McpSignInOverHttp = "loopback" | "never";

/** The connection a session acts through: one identity's secrets and tokens. */
export type McpCredentials = Pick<ConnectionHandle, "read" | "update">;

function storedOAuth(
  config: Readonly<Record<string, unknown>>,
): StoredOAuth | undefined {
  const stored = config[MCP_OAUTH_FIELD];
  if (
    !isRecord(stored) ||
    !isRecord(stored.definition) ||
    typeof stored.clientId !== "string"
  )
    return undefined;
  return stored as unknown as StoredOAuth;
}

/** Whether a connection holds a sign-in to an MCP server. */
export function signedIn(config: Readonly<Record<string, unknown>>): boolean {
  return !!storedOAuth(config) && config[MCP_GRANT_FIELD] !== undefined;
}

/** HTTP servers authenticate with OAuth unless the entry sends an `Authorization` header. */
export function usesOAuth(server: McpServer): boolean {
  if (server.kind !== "http" || !("url" in server.config)) return false;
  return !Object.keys(server.config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
}

/**
 * The connection config a completed sign-in is stored as: merge it into the
 * server's connection. A token response naming no scope was granted the
 * scope asked for (RFC 6749 section 5.1).
 */
export function mcpOAuthConnection(
  setup: McpOAuthSetup,
  tokens: OAuthTokens,
): Record<string, unknown> {
  const stored: StoredOAuth = {
    definition: setup.definition,
    clientId: setup.application.clientId,
    ...(setup.application.clientSecret === undefined
      ? {}
      : { clientSecret: setup.application.clientSecret }),
    scopes: setup.scopes,
  };
  return {
    [MCP_OAUTH_FIELD]: stored,
    [MCP_GRANT_FIELD]: {
      tokens:
        tokens.scope === undefined && setup.scopes.length
          ? { ...tokens, scope: setup.scopes.join(" ") }
          : tokens,
      revision: randomUUID(),
    },
  };
}

/** A sign-in problem as the error every caller of the server sees. */
export function signInRequired(
  server: string,
  hint: string,
  reason = "requires sign-in",
): McpServerError {
  return new McpServerError(
    "reconnect_required",
    `MCP server "${server}" ${reason}. ${hint}`,
    { server },
  );
}

/**
 * The redirect URI a sign-in uses: the entry's own, for a client
 * registered with a fixed one, else the caller's. An entry's callback
 * without a port takes `callbackPort`, else the caller's port.
 */
function entryRedirect(
  settings: { callbackUrl?: string; callbackPort?: number },
  fallback: string,
): string {
  if (settings.callbackUrl !== undefined) {
    const url = new URL(settings.callbackUrl);
    if (!url.port)
      url.port = String(settings.callbackPort ?? new URL(fallback).port);
    return url.toString();
  }
  return settings.callbackPort === undefined
    ? fallback
    : `http://127.0.0.1:${settings.callbackPort}/callback`;
}

/**
 * The Client ID Metadata Document to sign in as, chosen as pi and Codex
 * choose theirs, or undefined when the authorization server takes none from
 * a public client. A server whose responses carry no `iss` (RFC 9207) gets
 * a document and a redirect URI of its own, so a response cannot be taken
 * for another authorization server's (RFC 9700 section 4.4.2.2).
 */
function clientDocument(
  serverUrl: string,
  redirectUri: string,
  metadata: {
    client_id_metadata_document_supported?: boolean;
    token_endpoint_auth_methods_supported?: string[];
    authorization_response_iss_parameter_supported?: boolean;
  },
  baseUrl: string,
): { url: string; redirectUri: string } | undefined {
  if (
    !metadata.client_id_metadata_document_supported ||
    !metadata.token_endpoint_auth_methods_supported?.includes("none")
  )
    return undefined;
  if (metadata.authorization_response_iss_parameter_supported)
    return { url: `${baseUrl}/client.json`, redirectUri };
  const server = new URL(serverUrl);
  server.hash = "";
  const callbackId = createHash("sha256")
    .update(server.href)
    .digest()
    .subarray(0, 9)
    .toString("base64url");
  const redirect = new URL(redirectUri);
  redirect.pathname = `${redirect.pathname.replace(/\/$/, "")}/${callbackId}`;
  return {
    url: `${baseUrl}/${callbackId}/client.json`,
    redirectUri: redirect.href,
  };
}

/**
 * Find how to sign in to an HTTP server: its protected-resource and
 * authorization-server metadata through pi-mcp's discovery, the client to
 * sign in as, and the result as the OAuth2 definition codemode's own
 * runtime signs in with. The client is the one the entry names, else the
 * host's Client ID Metadata Document where the authorization server takes
 * one, else one registered through pi-mcp.
 */
export async function discoverMcpOAuth(options: {
  server: McpServer;
  /** Used unless the entry sets `oauth.callbackUrl` or `oauth.callbackPort`. */
  redirectUri: string;
  clientName: string;
  /** The server's `WWW-Authenticate` challenge, when it sent one. */
  challenge?: { resourceMetadataUrl?: URL; scope?: string };
  /** The entry's `oauth.clientSecret`, with its placeholders filled. */
  clientSecret?: string;
  /** The host's Client ID Metadata Documents. Default: none, so clients are registered. */
  clientMetadataDocuments?: McpClientMetadataDocuments;
  /** Default: `loopback`. */
  signInOverHttp?: McpSignInOverHttp;
  fetch?: McpFetch;
  signal?: AbortSignal;
}): Promise<McpOAuthSetup> {
  const { server, challenge } = options;
  const unsupported = (why: string) =>
    new McpServerError(
      "sign_in_unsupported",
      `MCP server "${server.name}" cannot be signed in to: ${why}`,
      { server: server.name },
    );
  if (server.kind !== "http" || !("url" in server.config))
    throw unsupported("only HTTP servers use OAuth");
  if (!usesOAuth(server))
    throw unsupported("its entry sends its own Authorization header");
  const settings = server.config.oauth ?? {};
  let redirectUri = entryRedirect(settings, options.redirectUri);
  const { discoverOAuthServerInfo, registerClient, selectResource } =
    await import("@earendil-works/pi-mcp/oauth");
  const info = await discoverOAuthServerInfo(server.config.url, {
    resourceMetadataUrl: challenge?.resourceMetadataUrl,
    authorizationServerMetadataUrl: settings.authServerMetadataUrl
      ? new URL(settings.authServerMetadataUrl)
      : undefined,
    fetch: options.fetch,
    signal: options.signal,
  });
  const metadata = info.authorizationServerMetadata;
  if (!metadata)
    throw unsupported("it publishes no authorization server metadata");
  if (!metadata.response_types_supported.includes("code"))
    throw unsupported(
      "its authorization server does not issue authorization codes",
    );
  if (
    metadata.code_challenge_methods_supported &&
    !metadata.code_challenge_methods_supported.includes("S256")
  )
    throw unsupported("its authorization server does not support PKCE S256");
  // A token, a code or a client's secret crosses each of these. Over http
  // it stays on this machine, or the sign-in is refused before a client is
  // registered.
  const overHttp = [
    server.config.url,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ].filter(
    (url): url is string =>
      url !== undefined &&
      URL.canParse(url) &&
      new URL(url).protocol === "http:",
  );
  const refused =
    options.signInOverHttp === "never"
      ? overHttp[0]
      : overHttp.find((url) => !isLoopbackHost(new URL(url).hostname));
  if (refused)
    throw unsupported(
      `${refused} is reached over http. Sign-in needs https${
        options.signInOverHttp === "never"
          ? ""
          : ", or a server on this machine"
      }.`,
    );
  // `||`, not `??`: an empty scope falls through to the next source.
  const scope =
    settings.scope ||
    challenge?.scope ||
    info.resourceMetadata?.scopes_supported?.join(" ") ||
    "";
  const scopes = scope.split(/\s+/).filter(Boolean);

  // Pi's rule: `auto` signs in as the document when the entry names no
  // client of its own and the documents list the redirect URI.
  const documents = options.clientMetadataDocuments;
  const registration = settings.clientRegistration ?? "auto";
  const listed = documents?.listsRedirectUrl(redirectUri) === true;
  const required = registration === "cimd";
  if (required && !listed)
    throw unsupported(
      `"oauth.clientRegistration": "cimd" needs client metadata documents that list the redirect URI ${redirectUri}`,
    );
  const offered =
    required ||
    (registration === "auto" &&
      settings.clientId === undefined &&
      settings.clientName === undefined);
  const document =
    offered && documents && listed
      ? clientDocument(
          server.config.url,
          redirectUri,
          metadata,
          documents.baseUrl,
        )
      : undefined;
  if (required && !document)
    throw unsupported(
      'its authorization server takes no client metadata document from a public client. Remove "oauth.clientRegistration": "cimd" from the entry.',
    );

  let application: OAuthApplication;
  let registeredMethod: string | undefined;
  if (settings.clientId !== undefined) {
    application = {
      clientId: settings.clientId,
      ...(options.clientSecret === undefined
        ? {}
        : { clientSecret: options.clientSecret }),
    };
  } else if (document) {
    application = { clientId: document.url };
    redirectUri = document.redirectUri;
  } else {
    if (!metadata.registration_endpoint)
      throw unsupported(
        'its authorization server does not register clients. Register one there and set "oauth.clientId" in the entry.',
      );
    const registered = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: settings.clientName ?? options.clientName,
      },
      scope: scope || undefined,
      fetch: options.fetch,
      signal: options.signal,
    });
    registeredMethod = registered.token_endpoint_auth_method;
    application = {
      clientId: registered.client_id,
      ...(registered.client_secret
        ? { clientSecret: registered.client_secret }
        : {}),
    };
  }

  const supported = metadata.token_endpoint_auth_methods_supported ?? [];
  const usable = (method: string) =>
    !supported.length || supported.includes(method);
  let clientAuthentication: OAuth2TokenEndpoint["clientAuthentication"];
  if (application.clientSecret === undefined)
    clientAuthentication = "client_id";
  else if (
    registeredMethod === "client_secret_post" &&
    usable(registeredMethod)
  )
    clientAuthentication = "client_secret_post";
  else
    clientAuthentication = usable("client_secret_basic")
      ? "client_secret_basic"
      : "client_secret_post";

  const resource = selectResource(server.config.url, info.resourceMetadata);
  const parameters = resource === undefined ? undefined : { resource };
  const token: OAuth2TokenEndpoint = {
    url: metadata.token_endpoint,
    clientAuthentication,
    ...(parameters ? { parameters } : {}),
  };
  const definition: OAuth2Definition = {
    id: CREDENTIAL_TYPE,
    provider: CREDENTIAL_TYPE,
    authorization: {
      url: metadata.authorization_endpoint,
      parameters: {
        ...parameters,
        // Without it, a provider may issue no refresh token for a consent it remembers.
        ...(scopes.includes("offline_access") ? { prompt: "consent" } : {}),
      },
    },
    exchange: { ...token, requirePkce: true },
    refresh: token,
  };
  try {
    registryFor(definition, []);
  } catch {
    throw unsupported(
      "its authorization server's endpoints cannot be used to sign in",
    );
  }
  return {
    definition,
    application,
    scopes,
    redirectUri,
    issuer: metadata.issuer,
    issuerRequired:
      metadata.authorization_response_iss_parameter_supported === true,
  };
}

/**
 * The credential type an MCP sign-in is renewed as: an `oauth2` method over
 * the discovered definition, its grant in `MCP_GRANT_FIELD`. It has no
 * target: the MCP client sends the requests, with the token it is handed.
 * Every other field the connection holds (the client, the values an
 * entry's placeholders name) is stored as it is.
 */
function registryFor(
  definition: OAuth2Definition,
  otherFields: string[],
): CredentialRegistry {
  const registry = new CredentialRegistry();
  registry.register({
    id: CREDENTIAL_TYPE,
    methods: {
      [CREDENTIAL_METHOD]: {
        schema: t.Object(
          {
            ...Object.fromEntries(
              otherFields.map((field) => [field, t.Unknown()]),
            ),
            [MCP_GRANT_FIELD]: OAuthGrantSchema,
          },
          { additionalProperties: false },
        ),
        authentication: {
          kind: "oauth2",
          field: MCP_GRANT_FIELD,
          definition,
          renewal: "refresh",
        },
        targets: {},
      },
    },
  });
  return registry;
}

/**
 * The token an MCP transport sends, from the connection a session acts
 * through. Codemode's credential transport reads the grant, renews it under
 * the connection's update ownership, and keeps one another caller renewed;
 * the MCP client stores nothing.
 */
export function createMcpAuthProvider(options: {
  server: McpServer;
  /** The connection in use now; a session's changes with each action call. */
  credentials: () => McpCredentials;
  /** Tells a person how to sign in, in the host's own terms. */
  signInHint: string;
  fetch?: typeof globalThis.fetch;
}): AuthProvider {
  const { server, signInHint } = options;
  const required = (reason?: string) =>
    signInRequired(server.name, signInHint, reason);

  /**
   * The transport of the definition and fields last seen. Both change only
   * with a sign-in or a new value in the connection, and a token is read
   * before every request.
   */
  let renewer: { key: string; transport: CredentialTransport } | undefined;
  const transportFor = (
    stored: StoredOAuth,
    otherFields: string[],
  ): CredentialTransport => {
    const key = JSON.stringify([stored.definition, otherFields]);
    if (renewer?.key !== key)
      renewer = {
        key,
        transport: new CredentialTransport(
          registryFor(stored.definition, otherFields),
          { fetch: options.fetch ?? globalThis.fetch },
        ),
      };
    return renewer.transport;
  };

  /** The current token, or undefined for a connection that is not signed in. */
  const token = async (rejected?: string): Promise<string | undefined> => {
    const credentials = options.credentials();
    const snapshot = await credentials.read();
    const stored = storedOAuth(snapshot.config);
    if (!stored || snapshot.config[MCP_GRANT_FIELD] === undefined)
      return undefined;
    try {
      return await transportFor(
        stored,
        Object.keys(snapshot.config).filter(
          (field) => field !== MCP_GRANT_FIELD,
        ),
      ).accessToken(
        {
          type: CREDENTIAL_TYPE,
          method: CREDENTIAL_METHOD,
          connection: credentials,
          identity: { name: snapshot.name, plugin: snapshot.plugin },
          application: {
            clientId: stored.clientId,
            ...(stored.clientSecret === undefined
              ? {}
              : { clientSecret: stored.clientSecret }),
          },
        },
        { rejected },
      );
    } catch (error) {
      // A grant that cannot be renewed, or has nothing to renew with, is a sign-in.
      if (
        error instanceof AuthError &&
        (error.code === "reconnect_required" ||
          error.code === "invalid_credentials" ||
          error.code === "invalid_definition")
      )
        throw required("needs you to sign in again");
      throw error;
    }
  };

  return {
    token: () => token(),
    async onUnauthorized(context) {
      // A 403 here is `insufficient_scope`: a refresh keeps the scope it has.
      if (context.response.status === 403)
        throw required("needs more access than the sign-in granted");
      if ((await token(context.token)) === undefined) throw required();
    },
  };
}
