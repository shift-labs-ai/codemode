# codemode-websearch

A [codemode](../../README.md) package with one plugin, `websearch`, whose one action searches the web through the search provider you have a key for.

Code calls `websearch.query` the same way whichever provider answers, and gets results in one shape. Code never names a provider: the connection chooses it, so changing provider changes a key or a setting, not the code.

## Install

Install the package and set the key of one provider:

```bash
codemode install npm:@shiftlabs/codemode-websearch
export BRAVE_API_KEY=...
```

It needs a codemode newer than 0.46.0.

## Search

`websearch.query` returns the results and the provider that gave them:

```bash
codemode exec 'return await websearch.query({ query: "duckdb 1.4 release notes", numResults: 2 })'
```

```json
{
  "provider": "brave",
  "results": [
    {
      "title": "Announcing DuckDB 1.4.0",
      "url": "https://duckdb.org/2025/09/16/announcing-duckdb-140.html",
      "content": "We are releasing DuckDB version 1.4.0, codenamed Andium...",
      "publishedDate": "2025-09-16T00:00:00"
    }
  ]
}
```

| Input | Meaning |
|---|---|
| `query` | What to search for |
| `numResults` | The most results to return. The default is 10 |
| `country` | A country to prefer results from |
| `language` | A language to prefer results in |
| `includeDomains` | Return results from these sites only |
| `excludeDomains` | Leave results from these sites out |
| `freshness` | Return only pages published this recently |

Each input has one form, and a value in another form is refused before any request:

| Input | Form | Example |
|---|---|---|
| `query` | Text of 1 to 400 characters | `"duckdb window functions"` |
| `numResults` | A whole number from 1 to 20 | `10` |
| `country` | An ISO 3166-1 alpha-2 code | `"DE"` |
| `language` | An ISO 639-1 code | `"de"` |
| `includeDomains`, `excludeDomains` | 1 to 20 hostnames, without `https://` or a path | `["duckdb.org"]` |
| `freshness` | `"day"`, `"week"`, `"month"`, or `"year"` | `"week"` |

A code or a hostname means the same in upper and lower case. Codemode turns each value into what the provider's API takes: `"DE"` reaches Parallel as `de`, Tavily as `germany`, and Brave as `DE`. The inputs are the same for every provider, and a search names no parameter of a provider's own.

| Result field | Contents |
|---|---|
| `title`, `url` | The page |
| `content` | The text the provider returned for the page: a snippet, excerpts, or the page itself |
| `publishedDate`, `author`, `sourceType` | Present when the provider gives them |

## Choose a provider

The connection chooses the provider, and a search has no input for it. A search goes to the connection's `provider` when it names one:

```bash
codemode connection add websearch --plugin websearch --set provider=tavily
```

Without one, a search goes to the first provider in this table that has a key and can apply the search's filters:

| Provider | Key | `country` | `language` | Filters |
|---|---|---|---|---|
| `parallel` | `PARALLEL_API_KEY` | Yes | No | Yes |
| `brave` | `BRAVE_API_KEY` | Yes | Yes | Yes |
| `exa` | `EXA_API_KEY` | Yes | No | Yes |
| `you` | `YOU_API_KEY` | Yes | Yes | Yes |
| `tavily` | `TAVILY_API_KEY` | Yes | Yes | Yes |
| `firecrawl` | `FIRECRAWL_API_KEY` | Yes | No | Yes |
| `jina` | `JINA_API_KEY` | Yes | Yes | No |
| `linkup` | `LINKUP_API_KEY` | No | No | Yes |
| `valyu` | `VALYU_API_KEY` | Yes | No | Yes |
| `perplexity` | `PERPLEXITY_API_KEY` | Yes | Yes | Yes |
| `serper` | `SERPER_API_KEY` | Yes | Yes | Yes |
| `serpapi` | `SERPAPI_API_KEY` | Yes | Yes | Yes |

The result's `provider` says which one answered.

## Narrow a search

`includeDomains`, `excludeDomains`, and `freshness` are filters. Every result meets them, or the call is refused. A connection that names no provider sends a filtered search to a provider that applies the filter:

```js
await websearch.query({
  query: "window functions",
  includeDomains: ["duckdb.org", "postgresql.org"],
  freshness: "year",
});

await websearch.query({ query: "duckdb benchmarks", excludeDomains: ["medium.com"] });
```

Set sites to search or sites to leave out, not both.

`country` and `language` are preferences. A provider that cannot localize searches without them, as the table above shows. Brave, You.com, and Valyu localize for 36 or 37 countries, and a search for another country reaches them without one.

## Configure the connection

Add a connection to keep keys in codemode, or to choose the provider. Every field is optional:

```bash
codemode connection add websearch --plugin websearch --set exaApiKey=$EXA_API_KEY --set tavilyApiKey=$TAVILY_API_KEY --set provider=tavily
```

| Field | Meaning |
|---|---|
| `provider` | The provider every search goes to. The default is the first with a key that can apply the search's filters |
| `<provider>ApiKey` | The provider's key, such as `braveApiKey`. The default is its environment variable |
| `firecrawlUrl` | A Firecrawl of your own, by its HTTPS address. The default is `FIRECRAWL_URL`, then `https://api.firecrawl.dev` |

Each key is declared with the one host that may receive it. A search through one provider sends no other provider's key, and codemode refuses a request to any other host.

## Add a provider

A host that embeds codemode builds the plugin from its own list of providers. A provider is its key's place in a request, the one HTTPS address that may receive the key, the parameters a search becomes, and how its answer reads as results:

```typescript
import { Codemode } from "@shiftlabs/codemode";
import { PROVIDERS, type SearchProvider, websearch } from "@shiftlabs/codemode-websearch";

const acme: SearchProvider = {
  name: "acme",
  env: "ACME_SEARCH_KEY",
  key: { header: "X-Acme-Key" },
  baseUrl: "https://search.acme.example/api/",
  method: "GET",
  path: "find",
  params: ({ query, numResults }) => ({ q: query, n: numResults }),
  results: (answer) =>
    (answer as { hits: Array<{ name: string; href: string; text: string }> }).hits.map(
      (hit) => ({ title: hit.name, url: hit.href, content: hit.text }),
    ),
};

const codemode = Codemode.create({ plugins: [websearch([acme, ...PROVIDERS])] });
```

The list's order is the order a provider is chosen in. Parameters go in the query of a `GET` and the JSON body of a `POST`. The package is TypeScript source, so the host imports it with a runtime that runs TypeScript, such as Bun.

## Handle failures

| Outcome | Result |
|---|---|
| No provider has a key | The call rejects and names the environment variables |
| The connection's provider has no key | The call rejects and names its environment variable |
| The connection's provider, or every provider with a key, cannot apply a filter | The call rejects and names the filter to search without |
| The provider refuses the request | The call rejects with `websearch.<provider>: request failed (HTTP <status>)` |
| The provider answers without results | Returns `results: []` |

A provider's error text is not included in the message, because it can repeat the key it was sent.

## Understand the limits

- Results are what the provider returns. Their length and freshness differ from provider to provider.
- Jina applies no filter. A filtered search goes to another provider with a key, and is refused when Jina is the connection's provider or holds the only key.
- Brave, Serper, and SerpAPI filter by site with `site:` operators added to the query. Brave takes a query of 600 characters, so a long query with many long hostnames can pass it and be refused.
- `freshness` reaches back 1, 7, 31, or 365 days, by the date a provider holds for a page.
- Serper and SerpAPI can return a first result with an empty `url`: what Google's results page says about the thing searched for.
- SerpAPI takes no number of results. It answers one page of Google's results, of which the first `numResults` are returned.
- A request to a provider is not ended when the run ends. It ends by itself within 60 seconds.
