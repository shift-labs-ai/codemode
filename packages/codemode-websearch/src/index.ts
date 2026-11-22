/**
 * Web search for codemode: one action that searches the web through the
 * provider the connection chooses, and answers results in one shape
 * whichever provider that was. Code never names a provider.
 *
 *   const { results } = await websearch.query({ query: "duckdb 1.4 release notes" })
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
import {
  type Freshness,
  PROVIDERS,
  type SearchProvider,
  type SearchRequest,
} from "./providers.js";

export * from "./providers.js";

const NAME = "websearch";
const DEFAULT_RESULTS = 10;
const MAX_RESULTS = 20;
const MAX_DOMAINS = 20;
/** The longest query every provider takes, with room for the sites a filter adds to it. */
const MAX_QUERY = 400;
/** A search that reads pages can take longer than the transport waits by default. */
const TIMEOUT_MS = 60_000;
/** How many days back each freshness reaches. */
const FRESHNESS_DAYS: Record<Freshness, number> = {
  day: 1,
  week: 7,
  month: 31,
  year: 365,
};
/** The inputs that narrow a search. A search goes only to a provider that applies those it sets. */
const FILTERS = ["includeDomains", "excludeDomains", "freshness"] as const;
/** A hostname, such as `duckdb.org`: no scheme, path or spaces. */
const DOMAIN = "^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$";

/** The connection field that holds a provider's key. */
function keyField(provider: SearchProvider): string {
  return `${provider.name}ApiKey`;
}

/** Whether the connection holds a key for the provider. */
function hasKey(
  provider: SearchProvider,
  config: Readonly<Record<string, unknown>>,
): boolean {
  return Boolean(config[keyField(provider)]);
}

/**
 * One credential for every provider: a part per provider, each optional and
 * each placed only on that provider's target, so a connection holds the keys
 * it has and a key is sent to its own provider alone. A target is the
 * provider's address, the method a search uses and the headers it carries.
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
        providers.map(
          ({ name, baseUrl, method, headers }): [string, CredentialTarget] => [
            name,
            {
              baseUrl:
                typeof baseUrl === "function" ? baseUrl(config) : baseUrl,
              methods: [method],
              ...(headers ? { allowedHeaders: Object.keys(headers) } : {}),
              timeoutMs: TIMEOUT_MS,
            },
          ],
        ),
      ),
  });
}

/**
 * The filters of a search that a provider does not apply: those whose
 * removal leaves the request the provider would send unchanged.
 */
function unapplied(provider: SearchProvider, search: SearchRequest): string[] {
  const sent = JSON.stringify(provider.params(search));
  return FILTERS.filter(
    (filter) =>
      search[filter] !== undefined &&
      sent ===
        JSON.stringify(
          provider.params({
            ...search,
            [filter]: undefined,
            ...(filter === "freshness" ? { publishedAfter: undefined } : {}),
          }),
        ),
  );
}

/**
 * The provider a search goes to. The connection decides, never the call:
 * its `provider` when it names one, else the first provider it has a key
 * for that applies the search's filters. A host that signs requests keeps
 * the keys, so only a connection that signs for itself (`signsItself`) is
 * asked to hold the key of the provider it names.
 */
function chosen(
  providers: SearchProvider[],
  config: Readonly<Record<string, unknown>>,
  signsItself: boolean,
  search: SearchRequest,
): SearchProvider {
  const name = config.provider;
  if (name === undefined) {
    const keyed = providers.filter((candidate) => hasKey(candidate, config));
    if (!keyed.length)
      throw new Error(
        `${NAME}: no search provider has a key. Set one of ${providers.map((candidate) => candidate.env).join(", ")}, or the connection's "provider" when the host keeps the keys.`,
      );
    const able = keyed.find(
      (candidate) => !unapplied(candidate, search).length,
    );
    if (able) return able;
    const set = FILTERS.filter((filter) => search[filter] !== undefined);
    throw new Error(
      `${NAME}: no provider with a key can filter by ${set.join(" and ")}. Search without one of them.`,
    );
  }
  const provider = providers.find((candidate) => candidate.name === name);
  if (!provider)
    throw new Error(
      `${NAME}: the connection names the provider ${JSON.stringify(name)}. The providers are ${providers.map((candidate) => candidate.name).join(", ")}.`,
    );
  if (signsItself && !hasKey(provider, config))
    throw new Error(
      `${NAME}: no key for ${provider.name}, the connection's provider. Set ${provider.env}.`,
    );
  const refused = unapplied(provider, search);
  if (refused.length)
    throw new Error(
      `${NAME}: ${provider.name}, the connection's provider, cannot filter by ${refused.join(" or ")}. Search without it.`,
    );
  return provider;
}

/** The codes that name something, by what they name. */
const CODES = {
  country: {
    names: new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }),
    standard: "ISO 3166-1 alpha-2",
    example: "US",
  },
  language: {
    names: new Intl.DisplayNames(["en"], {
      type: "language",
      fallback: "none",
    }),
    standard: "ISO 639-1",
    example: "en",
  },
};

/** Refuse a code in the right form that names no country, or no language. */
function checkCode(kind: keyof typeof CODES, code: string | undefined): void {
  const { names, standard, example } = CODES[kind];
  if (code !== undefined && !names.of(code))
    throw new Error(
      `${NAME}: ${code} is not a ${kind}. Pass an ${standard} code, such as ${example}.`,
    );
}

const lowerCase = (value: string) => value.toLowerCase();

/** The day `days` before today, as `YYYY-MM-DD`. */
function dayBefore(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** `params` without the entries that have no value. */
function defined(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
}

/**
 * The `websearch` plugin over `providers`, in the order one is chosen when
 * the connection names none. A host adds a provider of its own by passing a
 * list that includes it.
 */
export function websearch(
  providers: SearchProvider[] = PROVIDERS,
): PluginFunction {
  const credential = credentialOf(providers);
  const names = providers.map((provider) => provider.name);

  return function plugin(rl: CodemodePluginAPI): void {
    rl.setName(NAME);
    rl.setVersion(packageVersion(import.meta.url));
    rl.setDescription(
      "Search the web through the search provider the connection chooses.",
    );
    rl.setCredential(credential);
    rl.setConnectionSchema(
      t.Object({
        provider: t.Optional(
          t.String({
            enum: names,
            description:
              "The provider every search goes to. The default is the first provider with a key that can apply the search's filters",
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

    rl.registerAction("query", {
      access: "read",
      description:
        "Search the web. Returns results with a title, a URL and the text the provider returned for the page.",
      hints: { openWorld: true },
      inputSchema: t.Object(
        {
          query: t.String({
            minLength: 1,
            maxLength: MAX_QUERY,
            description: `What to search for, in up to ${MAX_QUERY} characters. Be specific and descriptive`,
          }),
          numResults: t.Optional(
            t.Integer({
              minimum: 1,
              maximum: MAX_RESULTS,
              description: `The most results to return, from 1 to ${MAX_RESULTS}. The default is ${DEFAULT_RESULTS}`,
            }),
          ),
          country: t.Optional(
            t.String({
              pattern: "^[A-Za-z]{2}$",
              description:
                "Country to prefer results from: an ISO 3166-1 alpha-2 code, such as US, GB, DE",
            }),
          ),
          language: t.Optional(
            t.String({
              pattern: "^[A-Za-z]{2}$",
              description:
                "Language to prefer results in: an ISO 639-1 code, such as en, es, fr",
            }),
          ),
          includeDomains: t.Optional(
            t.Array(t.String({ pattern: DOMAIN }), {
              minItems: 1,
              maxItems: MAX_DOMAINS,
              description:
                'Return results from these sites only: hostnames without https:// or a path, such as ["duckdb.org", "github.com"]. Not together with excludeDomains',
            }),
          ),
          excludeDomains: t.Optional(
            t.Array(t.String({ pattern: DOMAIN }), {
              minItems: 1,
              maxItems: MAX_DOMAINS,
              description:
                'Leave results from these sites out: hostnames in the same form, such as ["pinterest.com"]. Not together with includeDomains',
            }),
          ),
          freshness: t.Optional(
            t.String({
              enum: Object.keys(FRESHNESS_DAYS),
              description:
                "Return only pages published within the last day, week, month or year",
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
        if (input.includeDomains && input.excludeDomains)
          throw new Error(
            `${NAME}: set includeDomains or excludeDomains, not both.`,
          );
        // A code or a hostname means the same in either case, so each is put
        // in the one case the providers are written against.
        const country = input.country?.toUpperCase();
        const language = input.language?.toLowerCase();
        checkCode("country", country);
        checkCode("language", language);
        const numResults = input.numResults ?? DEFAULT_RESULTS;
        const freshness = input.freshness as Freshness | undefined;
        const search: SearchRequest = {
          query: input.query,
          numResults,
          country,
          language,
          includeDomains: input.includeDomains?.map(lowerCase),
          excludeDomains: input.excludeDomains?.map(lowerCase),
          freshness,
          publishedAfter: freshness && dayBefore(FRESHNESS_DAYS[freshness]),
        };
        const provider = chosen(
          providers,
          ctx.connection.config,
          !ctx.credentials,
          search,
        );
        const params = defined(provider.params(search));
        const answer = await credentialJson(
          ctx,
          credential,
          `${NAME}.${provider.name}`,
          {
            target: provider.name,
            path: provider.path,
            method: provider.method,
            ...(provider.method === "GET"
              ? { query: params }
              : { json: params }),
            ...(provider.headers ? { headers: provider.headers } : {}),
          },
        );
        // A provider that takes no number of results, or returns more than
        // it was asked for, is held to the number here.
        return {
          provider: provider.name,
          results: provider.results(answer).slice(0, numResults),
        };
      },
    });
  };
}

export default websearch();
