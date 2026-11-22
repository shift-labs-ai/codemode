/**
 * Web search for codemode: one action that searches the web through
 * whichever provider the connection has a key for, and answers results in
 * one shape whichever provider that was.
 *
 *   const { results } = await web.search({ query: "duckdb 1.4 release notes" })
 *
 * A connection holds a key per provider. Each key is declared with the one
 * host that may receive it, so a search through one provider sends no other
 * provider's key.
 */

import {
  type CodemodePluginAPI,
  type CredentialDeclaration,
  type CredentialTarget,
  credentialJson,
  type PluginFunction,
  staticCredential,
} from "@shiftlabs/codemode";
import { packageVersion } from "@shiftlabs/codemode/utils/cli";
import * as t from "typebox";
import { PROVIDERS, type SearchProvider } from "./providers.js";

export * from "./providers.js";

const NAME = "web";
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;
/** A search that reads pages can take longer than the transport waits by default. */
const TIMEOUT_MS = 60_000;

/** The connection field that holds a provider's key. */
function keyField(provider: SearchProvider): string {
  return `${provider.name}ApiKey`;
}

/**
 * One credential for every provider: a part per provider, each optional and
 * each placed only on that provider's target, so a connection holds the keys
 * it has and a key is sent to its own provider alone.
 */
function credentialOf(providers: SearchProvider[]): CredentialDeclaration {
  const names = providers.map((provider) => provider.name);
  return staticCredential({
    id: "codemodeWebsearch",
    auth: {
      kind: "static",
      parts: names,
      optionalParts: names,
      placements: providers.map(({ name, key }) =>
        "query" in key
          ? { in: "query", part: name, name: key.query, targets: [name] }
          : {
              in: "header",
              part: name,
              name: key.header,
              ...(key.prefix === undefined ? {} : { prefix: key.prefix }),
              targets: [name],
            },
      ),
    },
    local: Object.fromEntries(
      providers.map((provider) => [provider.name, keyField(provider)]),
    ),
    targets: (config) =>
      Object.fromEntries(
        providers.map(({ name, target }): [string, CredentialTarget] => [
          name,
          {
            timeoutMs: TIMEOUT_MS,
            ...(typeof target === "function" ? target(config) : target),
          },
        ]),
      ),
  });
}

/**
 * The provider a search goes to: the one the call names, else the
 * connection's `provider`, else the first with a key in the connection.
 */
function chosen(
  providers: SearchProvider[],
  config: Record<string, unknown>,
  named: string | undefined,
): SearchProvider {
  const name = named ?? config.provider;
  if (name !== undefined) {
    const provider = providers.find((candidate) => candidate.name === name);
    if (provider) return provider;
    throw new Error(
      `${NAME}: no provider named ${JSON.stringify(name)}. The providers are ${providers.map((candidate) => candidate.name).join(", ")}.`,
    );
  }
  const provider = providers.find((candidate) => config[keyField(candidate)]);
  if (provider) return provider;
  throw new Error(
    `${NAME}: no search provider has a key. Set one of ${providers.map((candidate) => candidate.env).join(", ")}, or the connection's "provider" when the host keeps the keys.`,
  );
}

/** `params` without the entries that have no value. */
function defined(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
}

/**
 * The `web` plugin over `providers`, in the order one is chosen when a
 * search names none. A host adds a provider of its own by passing a list
 * that includes it.
 */
export function webSearch(
  providers: SearchProvider[] = PROVIDERS,
): PluginFunction {
  const credential = credentialOf(providers);
  const names = providers.map((provider) => provider.name);

  return function web(rl: CodemodePluginAPI): void {
    rl.setName(NAME);
    rl.setVersion(packageVersion(import.meta.url));
    rl.setDescription(
      "Search the web through the search provider the connection has a key for.",
    );
    rl.setCredential(credential);
    rl.setConnectionSchema(
      t.Object({
        provider: t.Optional(
          t.String({
            enum: names,
            description:
              "The provider a search uses when it names none. The default is the first provider with a key",
          }),
        ),
        ...Object.fromEntries(
          providers.map((provider) => [
            keyField(provider),
            t.Optional(
              t.String({
                env: provider.env,
                description: `API key for ${provider.name}`,
              }),
            ),
          ]),
        ),
        ...Object.assign({}, ...providers.map((provider) => provider.fields)),
      }),
    );

    rl.registerAction("search", {
      access: "read",
      description:
        "Search the web. Returns results with a title, a URL and the text the provider returned for the page.",
      hints: { openWorld: true },
      inputSchema: t.Object(
        {
          query: t.String({
            minLength: 1,
            description: "What to search for. Be specific and descriptive",
          }),
          numResults: t.Optional(
            t.Integer({
              minimum: 1,
              maximum: MAX_RESULTS,
              description: `How many results to return, from 1 to ${MAX_RESULTS}. The default is ${DEFAULT_RESULTS}`,
            }),
          ),
          country: t.Optional(
            t.String({
              pattern: "^[A-Za-z]{2}$",
              description:
                "Two-letter country code to localize results, such as us, gb, de",
            }),
          ),
          language: t.Optional(
            t.String({
              pattern: "^[A-Za-z]{2}$",
              description:
                "Two-letter language code of the results, such as en, es, fr",
            }),
          ),
          provider: t.Optional(
            t.String({
              enum: names,
              description:
                "The provider to search with. The default is the connection's",
            }),
          ),
          options: t.Optional(
            t.Record(t.String(), t.Unknown(), {
              description:
                "Parameters of the provider's own search API, under the names it gives them. They replace what the search would send under the same name",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      outputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                content: { type: "string" },
                publishedDate: { type: "string" },
                author: { type: "string" },
                sourceType: { type: "string" },
              },
              required: ["title", "url", "content"],
            },
          },
        },
        required: ["provider", "results"],
      },
      async execute(input, ctx) {
        const provider = chosen(
          providers,
          ctx.connection.config,
          input.provider,
        );
        // A host that signs requests keeps the keys, so only a connection
        // that signs for itself is asked for one here.
        if (!ctx.credentials && !ctx.connection.config[keyField(provider)])
          throw new Error(
            `${NAME}: no key for ${provider.name}. Set ${provider.env}, or search with a provider that has one.`,
          );
        const method = (
          typeof provider.target === "function"
            ? provider.target(ctx.connection.config)
            : provider.target
        ).methods[0];
        const params = defined({
          ...provider.params({
            query: input.query,
            numResults: input.numResults ?? DEFAULT_RESULTS,
            country: input.country?.toLowerCase(),
            language: input.language?.toLowerCase(),
          }),
          ...input.options,
        });
        const answer = await credentialJson(
          ctx,
          credential,
          `${NAME}.${provider.name}`,
          {
            target: provider.name,
            path: provider.path,
            method,
            ...(method === "GET" ? { query: params } : { json: params }),
            ...(provider.headers ? { headers: provider.headers } : {}),
          },
        );
        return { provider: provider.name, results: provider.results(answer) };
      },
    });
  };
}

export default webSearch();
