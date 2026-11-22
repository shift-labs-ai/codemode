/**
 * The web search package: its one action through a real engine with the
 * providers' hosts stood in for, and the package as codemode's package
 * manager loads it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Codemode } from "@shiftlabs/codemode";
import { stubFetch } from "../../codemode/src/tests/helpers/plugin.js";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import plugin, {
  PROVIDERS,
  type SearchProvider,
  type SearchResult,
  websearch,
} from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answer every request with `answer`, and collect what was sent. */
function provider(answer: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
  stubFetch(async (url, init) => {
    const body = init?.body;
    sent.push({
      method: init?.method ?? "GET",
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: body
        ? JSON.parse(Buffer.from(body as Uint8Array).toString())
        : null,
    });
    return Response.json(answer, { status });
  });
  return sent;
}

interface Found {
  provider: string;
  results: SearchResult[];
}

const harness = pluginHarness(plugin, "websearch");
const search = (
  input: Record<string, unknown>,
  config: Record<string, unknown>,
) => harness.call<Found>("query", input, config);

/** A failed search's error text. */
async function refused(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<string> {
  const { error } = await harness
    .codemode(config)
    .execute(`return await websearch.query(${JSON.stringify(input)})`);
  assert.ok(error, "the search should fail");
  return error;
}

/** A connection with a key for every provider. */
const ALL_KEYS = Object.fromEntries(
  PROVIDERS.map(({ name }) => [`${name}ApiKey`, `KEY-${name}`]),
);

/** A connection with a key for every provider, whose provider is `name`. */
const through = (name: string) => ({ ...ALL_KEYS, provider: name });

const SEARCH = {
  query: "duckdb release",
  numResults: 3,
  country: "DE",
  language: "de",
};

/**
 * For each provider: the request a search becomes, an answer in the shape
 * its reference documents, and the results that answer reads as.
 */
const CASES: Record<
  string,
  {
    request: Omit<Sent, "headers"> & { key: [string, string] | "query" };
    answer: unknown;
    results: SearchResult[];
  }
> = {
  parallel: {
    request: {
      method: "POST",
      url: "https://api.parallel.ai/v1/search",
      key: ["x-api-key", "KEY-parallel"],
      body: {
        objective: "duckdb release",
        search_queries: ["duckdb release"],
        mode: "fast",
        advanced_settings: { max_results: 3, location: "de" },
      },
    },
    answer: {
      search_id: "search_1",
      results: [
        {
          url: "https://a.example/1",
          title: "One",
          publish_date: "2026-01-15",
          excerpts: ["first", "second"],
        },
        { url: "https://a.example/2", title: null, excerpts: [] },
      ],
    },
    results: [
      {
        title: "One",
        url: "https://a.example/1",
        content: "first\n\nsecond",
        publishedDate: "2026-01-15",
      },
      { title: "https://a.example/2", url: "https://a.example/2", content: "" },
    ],
  },
  brave: {
    request: {
      method: "GET",
      url: "https://api.search.brave.com/res/v1/web/search?q=duckdb+release&count=3&country=DE&search_lang=de",
      key: ["x-subscription-token", "KEY-brave"],
      body: null,
    },
    answer: {
      web: {
        results: [
          {
            title: "One",
            url: "https://a.example/1",
            description: "about",
            extra_snippets: ["more"],
            page_age: "2026-02-01T00:00:00",
          },
        ],
      },
    },
    results: [
      {
        title: "One",
        url: "https://a.example/1",
        content: "about\n\nmore",
        publishedDate: "2026-02-01T00:00:00",
      },
    ],
  },
  exa: {
    request: {
      method: "POST",
      url: "https://api.exa.ai/search",
      key: ["x-api-key", "KEY-exa"],
      body: {
        query: "duckdb release",
        numResults: 3,
        type: "auto",
        contents: { text: { maxCharacters: 3000 }, highlights: true },
        userLocation: "DE",
      },
    },
    answer: {
      results: [
        {
          title: "One",
          url: "https://a.example/1",
          text: "body",
          highlights: ["key line"],
          publishedDate: "2026-03-01",
          author: "Ada",
        },
      ],
    },
    results: [
      {
        title: "One",
        url: "https://a.example/1",
        content: "body\n\nkey line",
        publishedDate: "2026-03-01",
        author: "Ada",
      },
    ],
  },
  you: {
    request: {
      method: "POST",
      url: "https://ydc-index.io/v1/search",
      key: ["x-api-key", "KEY-you"],
      body: {
        query: "duckdb release",
        count: 3,
        country: "DE",
        language: "DE",
      },
    },
    answer: {
      results: {
        web: [
          {
            url: "https://a.example/1",
            title: "One",
            description: "about",
            page_age: "2026-02-16T21:26:51",
            contents: { highlights: ["h1", "h2"] },
          },
          { url: "https://a.example/2", title: "Two", snippets: ["s1"] },
          { url: "https://a.example/3", title: "Three", description: "d3" },
        ],
      },
    },
    results: [
      {
        title: "One",
        url: "https://a.example/1",
        content: "h1\n\nh2",
        publishedDate: "2026-02-16T21:26:51",
      },
      { title: "Two", url: "https://a.example/2", content: "s1" },
      { title: "Three", url: "https://a.example/3", content: "d3" },
    ],
  },
  tavily: {
    request: {
      method: "POST",
      url: "https://api.tavily.com/search",
      key: ["authorization", "Bearer KEY-tavily"],
      body: {
        query: "duckdb release",
        max_results: 3,
        search_depth: "basic",
        country: "germany",
        language: "de",
      },
    },
    answer: {
      results: [
        {
          title: "One",
          url: "https://a.example/1",
          content: "about",
          score: 0.9,
        },
      ],
    },
    results: [{ title: "One", url: "https://a.example/1", content: "about" }],
  },
  firecrawl: {
    request: {
      method: "POST",
      url: "https://api.firecrawl.dev/v2/search",
      key: ["authorization", "Bearer KEY-firecrawl"],
      body: { query: "duckdb release", limit: 3, country: "DE" },
    },
    answer: {
      success: true,
      data: {
        web: [
          { title: "One", url: "https://a.example/1", description: "about" },
          { url: "https://a.example/2", markdown: "# Two" },
        ],
      },
    },
    results: [
      { title: "One", url: "https://a.example/1", content: "about" },
      {
        title: "https://a.example/2",
        url: "https://a.example/2",
        content: "# Two",
      },
    ],
  },
  jina: {
    request: {
      method: "POST",
      url: "https://s.jina.ai/",
      key: ["authorization", "Bearer KEY-jina"],
      body: { q: "duckdb release", num: 3, gl: "de", hl: "de" },
    },
    answer: {
      data: [
        { title: "One", url: "https://a.example/1", content: "page" },
        { title: "Two", url: "https://a.example/2", description: "about" },
      ],
    },
    results: [
      { title: "One", url: "https://a.example/1", content: "page" },
      { title: "Two", url: "https://a.example/2", content: "about" },
    ],
  },
  linkup: {
    request: {
      method: "POST",
      url: "https://api.linkup.so/v1/search",
      key: ["authorization", "Bearer KEY-linkup"],
      body: {
        q: "duckdb release",
        depth: "standard",
        outputType: "searchResults",
        includeImages: false,
        maxResults: 3,
      },
    },
    answer: {
      results: [
        {
          type: "text",
          name: "One",
          url: "https://a.example/1",
          content: "about",
        },
      ],
    },
    results: [{ title: "One", url: "https://a.example/1", content: "about" }],
  },
  valyu: {
    request: {
      method: "POST",
      url: "https://api.valyu.ai/v1/search",
      key: ["x-api-key", "KEY-valyu"],
      body: {
        query: "duckdb release",
        search_type: "all",
        max_num_results: 3,
        country_code: "DE",
      },
    },
    answer: {
      success: true,
      results: [
        {
          title: "One",
          url: "https://a.example/1",
          content: "about",
          source_type: "paper",
          publication_date: "",
        },
      ],
    },
    results: [
      {
        title: "One",
        url: "https://a.example/1",
        content: "about",
        sourceType: "paper",
      },
    ],
  },
  perplexity: {
    request: {
      method: "POST",
      url: "https://api.perplexity.ai/search",
      key: ["authorization", "Bearer KEY-perplexity"],
      body: {
        query: "duckdb release",
        max_results: 3,
        country: "DE",
        search_language_filter: ["de"],
      },
    },
    answer: {
      id: "r1",
      results: [
        {
          title: "One",
          url: "https://a.example/1",
          snippet: "about",
          date: "2026-06-10",
          last_updated: "2026-11-18",
        },
      ],
    },
    results: [
      {
        title: "One",
        url: "https://a.example/1",
        content: "about",
        publishedDate: "2026-06-10",
      },
    ],
  },
  serper: {
    request: {
      method: "POST",
      url: "https://google.serper.dev/search",
      key: ["x-api-key", "KEY-serper"],
      body: { q: "duckdb release", num: 3, gl: "de", hl: "de" },
    },
    answer: {
      knowledgeGraph: { title: "DuckDB", description: "A database" },
      organic: [
        { title: "One", link: "https://a.example/1", snippet: "about" },
      ],
    },
    results: [
      { title: "Knowledge Graph: DuckDB", url: "", content: "A database" },
      { title: "One", url: "https://a.example/1", content: "about" },
    ],
  },
  serpapi: {
    request: {
      method: "GET",
      url: "https://serpapi.com/search.json?q=duckdb+release&engine=google&gl=de&hl=de&api_key=KEY-serpapi",
      key: "query",
      body: null,
    },
    answer: {
      organic_results: [
        {
          title: "One",
          link: "https://a.example/1",
          snippet: "about",
          date: "Mar 1, 2026",
        },
      ],
    },
    results: [
      {
        title: "One",
        url: "https://a.example/1",
        content: "about",
        publishedDate: "Mar 1, 2026",
      },
    ],
  },
};

describe("websearch.query through each provider", () => {
  it("has a case for every provider", () => {
    assert.deepEqual(
      Object.keys(CASES),
      PROVIDERS.map(({ name }) => name),
    );
  });

  for (const [name, { request, answer, results }] of Object.entries(CASES)) {
    it(`${name}: sends its API's request with its own key alone, and reads its answer`, async () => {
      const sent = provider(answer);
      const found = await search(SEARCH, through(name));
      assert.deepEqual(found, { provider: name, results });
      assert.equal(sent.length, 1);
      const [{ method, url, headers, body }] = sent;
      assert.deepEqual(
        { method, url, body },
        {
          method: request.method,
          url: request.url,
          body: request.body,
        },
      );
      if (request.key !== "query")
        assert.equal(headers[request.key[0]], request.key[1]);
      const everything = JSON.stringify(sent);
      for (const other of PROVIDERS)
        assert.equal(
          everything.includes(`KEY-${other.name}`),
          other.name === name,
          `${other.name}'s key in a request to ${name}`,
        );
    });
  }

  it("sends only what a search sets", async () => {
    const sent = provider({ web: { results: [] } });
    const found = await search({ query: "plain" }, { braveApiKey: "k" });
    assert.deepEqual(found, { provider: "brave", results: [] });
    assert.equal(
      sent[0].url,
      "https://api.search.brave.com/res/v1/web/search?q=plain&count=10",
    );
  });

  it("returns no more results than were asked for, whatever the provider answers", async () => {
    provider({
      organic_results: [1, 2, 3, 4].map((n) => ({
        title: `T${n}`,
        link: `https://a.example/${n}`,
        snippet: "s",
      })),
    });
    const found = await search(
      { query: "q", numResults: 2 },
      through("serpapi"),
    );
    assert.deepEqual(
      found.results.map(({ title }) => title),
      ["T1", "T2"],
    );
  });

  it("carries the headers a provider always sends", async () => {
    const sent = provider({ data: [] });
    await search({ query: "plain" }, { jinaApiKey: "k" });
    assert.equal(sent[0].headers["x-retain-images"], "none");
  });
});

describe("the provider a search uses", () => {
  it("is the first with a key, in the providers' order", async () => {
    provider({ results: [] });
    const found = await search(
      { query: "q" },
      { tavilyApiKey: "t", exaApiKey: "e", serperApiKey: "s" },
    );
    assert.equal(found.provider, "exa");
  });

  it("is the connection's, when it names one", async () => {
    const sent = provider({ results: [] });
    assert.equal(
      (await search({ query: "q" }, through("tavily"))).provider,
      "tavily",
    );
    assert.equal(new URL(sent[0].url).host, "api.tavily.com");
  });

  it("is never the call's: a search has no input that names one", async () => {
    const sent = provider({ results: [] });
    assert.match(
      await refused({ query: "q", provider: "exa" }, ALL_KEYS),
      /Invalid input for websearch\.query/,
    );
    assert.equal(sent.length, 0);
  });

  it("says which keys to set when there is none", async () => {
    const sent = provider({});
    const error = await refused({ query: "q" }, {});
    assert.match(
      error,
      /websearch: no search provider has a key\. Set one of /,
    );
    for (const { env } of PROVIDERS) assert.ok(error.includes(env), env);
    assert.equal(sent.length, 0);
  });

  it("is refused before any request when the connection names one it has no key for", async () => {
    const sent = provider({});
    const error = await refused(
      { query: "q" },
      { exaApiKey: "e", provider: "brave" },
    );
    assert.equal(
      error.split("\n")[0],
      "Error: websearch: no key for brave, the connection's provider. Set BRAVE_API_KEY.",
    );
    assert.equal(sent.length, 0);
  });

  it("is refused when the connection names one that does not exist", async () => {
    const sent = provider({});
    assert.match(
      await refused({ query: "q" }, through("altavista")),
      /websearch: the connection names the provider "altavista"\. The providers are parallel, brave, /,
    );
    assert.equal(sent.length, 0);
  });
});

/** The day `days` before today, as the plugin writes it. */
const dayBefore = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/**
 * For each provider that filters: what a search for the last week on two
 * sites adds to its request, and what leaving one site out adds instead.
 * `WEEK_AGO` stands for the day a week back.
 */
const FILTERED: Record<string, { only: object; without: object }> = {
  parallel: {
    only: {
      advanced_settings: {
        max_results: 10,
        source_policy: {
          include_domains: ["a.example", "b.example"],
          after_date: "WEEK_AGO",
        },
      },
    },
    without: {
      advanced_settings: {
        max_results: 10,
        source_policy: { exclude_domains: ["c.example"] },
      },
    },
  },
  brave: {
    only: { q: "q (site:a.example OR site:b.example)", freshness: "pw" },
    without: { q: "q -site:c.example" },
  },
  exa: {
    only: {
      includeDomains: ["a.example", "b.example"],
      startPublishedDate: "WEEK_AGOT00:00:00.000Z",
    },
    without: { excludeDomains: ["c.example"] },
  },
  you: {
    only: { include_domains: ["a.example", "b.example"], freshness: "week" },
    without: { exclude_domains: ["c.example"] },
  },
  tavily: {
    only: { include_domains: ["a.example", "b.example"], time_range: "week" },
    without: { exclude_domains: ["c.example"] },
  },
  firecrawl: {
    only: { includeDomains: ["a.example", "b.example"], tbs: "qdr:w" },
    without: { excludeDomains: ["c.example"] },
  },
  linkup: {
    only: { includeDomains: ["a.example", "b.example"], fromDate: "WEEK_AGO" },
    without: { excludeDomains: ["c.example"] },
  },
  valyu: {
    only: {
      included_sources: ["a.example", "b.example"],
      start_date: "WEEK_AGO",
    },
    without: { excluded_sources: ["c.example"] },
  },
  perplexity: {
    only: {
      search_domain_filter: ["a.example", "b.example"],
      search_recency_filter: "week",
    },
    without: { search_domain_filter: ["-c.example"] },
  },
  serper: {
    only: { q: "q (site:a.example OR site:b.example)", tbs: "qdr:w" },
    without: { q: "q -site:c.example" },
  },
  serpapi: {
    only: { q: "q (site:a.example OR site:b.example)", tbs: "qdr:w" },
    without: { q: "q -site:c.example" },
  },
};

/** What was sent as parameters: the query of a GET, the body of a POST. */
function parameters({ method, url, body }: Sent): Record<string, unknown> {
  if (method !== "GET") return body as Record<string, unknown>;
  const { api_key: _, ...query } = Object.fromEntries(
    new URL(url).searchParams,
  );
  return query;
}

describe("the filters of a search", () => {
  it("has a case for every provider but jina, which has no filters", () => {
    assert.deepEqual(
      Object.keys(FILTERED),
      PROVIDERS.map(({ name }) => name).filter((name) => name !== "jina"),
    );
  });

  for (const [name, { only, without }] of Object.entries(FILTERED)) {
    it(`${name}: sends sites and freshness as its API names them`, async () => {
      const sent = provider({});
      const before = dayBefore(7);
      await search({ query: "q" }, through(name));
      await search(
        {
          query: "q",
          includeDomains: ["a.example", "b.example"],
          freshness: "week",
        },
        through(name),
      );
      await search(
        { query: "q", excludeDomains: ["c.example"] },
        through(name),
      );
      const [plain, narrowed, excluded] = sent.map(parameters);
      // The day a week back is the one before the search, or the one after
      // it when midnight fell between.
      const expected = [before, dayBefore(7)].map((weekAgo) => ({
        ...plain,
        ...JSON.parse(JSON.stringify(only).replaceAll("WEEK_AGO", weekAgo)),
      }));
      assert.ok(
        expected.some((one) => isDeepStrictEqual(narrowed, one)),
        JSON.stringify(narrowed),
      );
      assert.deepEqual(excluded, { ...plain, ...without });
    });
  }

  it("writes one site without brackets", async () => {
    const sent = provider({});
    await search(
      { query: "q", includeDomains: ["a.example"] },
      through("brave"),
    );
    assert.equal(
      new URL(sent[0].url).searchParams.get("q"),
      "q site:a.example",
    );
  });

  it("go to the first provider with a key that applies them, when the connection names none", async () => {
    const sent = provider({});
    const keys = { jinaApiKey: "j", serperApiKey: "s" };
    assert.equal((await search({ query: "q" }, keys)).provider, "jina");
    assert.equal(
      (await search({ query: "q", freshness: "day" }, keys)).provider,
      "serper",
    );
    assert.deepEqual(
      sent.map(({ url }) => new URL(url).host),
      ["s.jina.ai", "google.serper.dev"],
    );
  });

  it("are refused when no provider with a key applies them", async () => {
    const sent = provider({});
    assert.equal(
      (
        await refused(
          { query: "q", includeDomains: ["a.example"], freshness: "day" },
          { jinaApiKey: "j" },
        )
      ).split("\n")[0],
      "Error: websearch: no provider with a key can filter by includeDomains and freshness. Search without one of them.",
    );
    assert.equal(sent.length, 0);
  });

  it("are refused when the connection's provider does not apply them", async () => {
    const sent = provider({});
    assert.equal(
      (await refused({ query: "q", freshness: "day" }, through("jina"))).split(
        "\n",
      )[0],
      "Error: websearch: jina, the connection's provider, cannot filter by freshness. Search without it.",
    );
    assert.equal(sent.length, 0);
  });

  it("takes sites to search or sites to leave out, not both", async () => {
    const sent = provider({});
    assert.match(
      await refused(
        {
          query: "q",
          includeDomains: ["a.example"],
          excludeDomains: ["b.example"],
        },
        ALL_KEYS,
      ),
      /websearch: set includeDomains or excludeDomains, not both\./,
    );
    assert.equal(sent.length, 0);
  });
});

describe("a country and a language", () => {
  /** What each of these providers is sent for a search with these codes. */
  const sentFor = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const sent = provider({});
    await search({ query: "q", ...input }, through(name));
    return parameters(sent[0]);
  };

  it("reach each provider in the form its API documents", async () => {
    const codes = { country: "GB", language: "pt" };
    assert.deepEqual(
      {
        parallel: (await sentFor("parallel", codes)).advanced_settings,
        brave: await sentFor("brave", codes),
        you: await sentFor("you", codes),
        tavily: await sentFor("tavily", codes),
        serper: await sentFor("serper", codes),
      },
      {
        parallel: { max_results: 10, location: "gb" },
        brave: { q: "q", count: "10", country: "GB", search_lang: "pt-br" },
        you: { query: "q", count: 10, country: "GB", language: "PT-BR" },
        tavily: {
          query: "q",
          max_results: 10,
          search_depth: "basic",
          country: "united kingdom",
          language: "pt",
        },
        serper: { q: "q", num: 10, gl: "gb", hl: "pt" },
      },
    );
  });

  it("name a language as the provider does where it takes one only with a script or a region", async () => {
    const chinese = { language: "zh" };
    assert.deepEqual(
      [
        (await sentFor("brave", chinese)).search_lang,
        (await sentFor("you", chinese)).language,
        (await sentFor("serpapi", chinese)).hl,
        (await sentFor("tavily", chinese)).language,
      ],
      ["zh-hans", "ZH-HANS", "zh-cn", "zh"],
    );
  });

  it("are left out for a provider whose list does not have them", async () => {
    // Israel and Tibetan: real codes that Brave, You.com, Valyu and Google's
    // language list do not carry.
    const codes = { country: "IL", language: "bo" };
    assert.deepEqual(await sentFor("brave", codes), { q: "q", count: "10" });
    assert.deepEqual(await sentFor("you", codes), { query: "q", count: 10 });
    assert.deepEqual(await sentFor("valyu", codes), {
      query: "q",
      search_type: "all",
      max_num_results: 10,
    });
    assert.deepEqual(await sentFor("serpapi", codes), {
      q: "q",
      engine: "google",
      gl: "il",
    });
    assert.deepEqual(await sentFor("perplexity", codes), {
      query: "q",
      max_results: 10,
      country: "IL",
      search_language_filter: ["bo"],
    });
  });

  it("mean the same in either case, as a hostname does", async () => {
    assert.deepEqual(
      await sentFor("perplexity", {
        country: "gb",
        language: "PT",
        includeDomains: ["DuckDB.org"],
      }),
      {
        query: "q",
        max_results: 10,
        country: "GB",
        search_language_filter: ["pt"],
        search_domain_filter: ["duckdb.org"],
      },
    );
    assert.deepEqual(
      await sentFor("brave", { excludeDomains: ["Medium.COM"] }),
      { q: "q -site:medium.com", count: "10" },
    );
  });

  it("are refused when they name no country or language", async () => {
    const sent = provider({});
    assert.match(
      await refused({ query: "q", country: "XX" }, ALL_KEYS),
      /websearch: XX is not a country\. Pass an ISO 3166-1 alpha-2 code, such as US\./,
    );
    assert.match(
      await refused({ query: "q", language: "xx" }, ALL_KEYS),
      /websearch: xx is not a language\. Pass an ISO 639-1 code, such as en\./,
    );
    assert.equal(sent.length, 0);
  });
});

describe("what a search accepts", () => {
  it("refuses a value in another form than the one each input has, and an input it does not have", async () => {
    const sent = provider({});
    for (const input of [
      { query: "q", numResults: 0 },
      { query: "q", numResults: 21 },
      { query: "q", numResults: 2.5 },
      { query: "q", country: "germany" },
      { query: "q", language: "eng" },
      { query: "x".repeat(401) },
      { query: "" },
      { query: "q", depth: "deep" },
      { query: "q", options: { freshness: "pw" } },
      { query: "q", freshness: "fortnight" },
      { query: "q", includeDomains: [] },
      { query: "q", includeDomains: ["https://a.example/docs"] },
      { query: "q", excludeDomains: ["a example"] },
    ])
      assert.match(
        await refused(input, ALL_KEYS),
        /Invalid input for websearch\.query/,
        JSON.stringify(input),
      );
    assert.equal(sent.length, 0);
  });
});

describe("a provider that fails", () => {
  it("is reported by provider and status, without what it answered", async () => {
    provider({ error: "the key KEY-brave is not valid" }, 401);
    const error = await refused({ query: "q" }, through("brave"));
    assert.match(error, /websearch\.brave: request failed \(HTTP 401\)/);
    assert.ok(!error.includes("KEY-brave"));
  });

  it("reads an answer without results as none", async () => {
    provider({ unexpected: true });
    for (const { name } of PROVIDERS)
      assert.deepEqual(await search({ query: "q" }, through(name)), {
        provider: name,
        results: [],
      });
  });
});

describe("a Firecrawl of the host's own", () => {
  it("is searched at its address", async () => {
    const sent = provider({ data: { web: [] } });
    await search(
      { query: "q" },
      { firecrawlApiKey: "k", firecrawlUrl: "https://crawl.acme.example" },
    );
    assert.equal(sent[0].url, "https://crawl.acme.example/v2/search");
  });

  it("is refused over plain HTTP, where the key would travel in the clear", async () => {
    const sent = provider({});
    assert.match(
      await refused(
        { query: "q" },
        { firecrawlApiKey: "k", firecrawlUrl: "http://crawl.acme.example" },
      ),
      /Missing or invalid authentication credentials/,
    );
    assert.equal(sent.length, 0);
  });
});

describe("a provider a host adds", () => {
  const acme: SearchProvider = {
    name: "acme",
    env: "ACME_SEARCH_KEY",
    key: { header: "X-Acme-Key" },
    baseUrl: "https://search.acme.example/api/",
    method: "GET",
    path: "find",
    params: ({ query, numResults }) => ({ q: query, n: numResults }),
    results: (answer) =>
      (answer as { hits: Array<{ name: string; href: string }> }).hits.map(
        ({ name, href }) => ({ title: name, url: href, content: "" }),
      ),
  };
  const extended = pluginHarness(websearch([acme, ...PROVIDERS]), "websearch");

  it("is searched like the others, with a key of its own", async () => {
    const sent = provider({
      hits: [{ name: "One", href: "https://a.example" }],
    });
    const found = await extended.call<Found>(
      "query",
      { query: "q" },
      { ...ALL_KEYS, acmeApiKey: "KEY-acme" },
    );
    assert.deepEqual(found, {
      provider: "acme",
      results: [{ title: "One", url: "https://a.example", content: "" }],
    });
    assert.equal(sent[0].url, "https://search.acme.example/api/find?q=q&n=10");
    assert.equal(sent[0].headers["x-acme-key"], "KEY-acme");
    assert.ok(!JSON.stringify(sent).includes("KEY-parallel"));
  });
});

describe("a host that keeps the keys", () => {
  it("is asked to sign the request for the connection's provider, which holds no key", async () => {
    const sent = provider({});
    const requests: unknown[] = [];
    const codemode = Codemode.create({
      plugins: [plugin],
      connections: [
        {
          name: "websearch",
          plugin: "websearch",
          config: { provider: "exa" },
        },
      ],
      credentialBroker: () => ({
        request: async (request) => {
          requests.push(request);
          return Response.json({
            results: [{ title: "One", url: "https://a.example/1", text: "t" }],
          });
        },
        probe: async () => ({ outcome: "unverified" }),
      }),
    });
    try {
      const { result, error } = await codemode.execute(
        'return await websearch.query({ query: "q" })',
      );
      assert.equal(error, undefined);
      assert.deepEqual(result, {
        provider: "exa",
        results: [{ title: "One", url: "https://a.example/1", content: "t" }],
      });
      assert.deepEqual(requests, [
        {
          target: "exa",
          path: "search",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query: "q",
            numResults: 10,
            type: "auto",
            contents: { text: { maxCharacters: 3000 }, highlights: true },
          }),
        },
      ]);
      assert.equal(sent.length, 0);
    } finally {
      codemode.dispose();
    }
  });
});

describe("the README", () => {
  it("lists the providers in their order, with each key, what a search sends it and whether it filters", () => {
    const readme = readFileSync(join(PACKAGE, "README.md"), "utf8");
    const rows = [
      ...readme.matchAll(
        /^\| `(\w+)` \| `(\w+)` \| (Yes|No) \| (Yes|No) \| (Yes|No) \|$/gm,
      ),
    ].map(([, ...row]) => row);
    assert.deepEqual(
      rows,
      PROVIDERS.map(({ name, env, params }) => {
        const plain = { query: "q", numResults: 5 };
        const changes = (more: object) =>
          JSON.stringify(params({ ...plain, ...more })) ===
          JSON.stringify(params(plain))
            ? "No"
            : "Yes";
        return [
          name,
          env,
          changes({ country: "DE" }),
          changes({ language: "de" }),
          changes({ includeDomains: ["a.example"] }),
        ];
      }),
    );
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-websearch",
  plugin: "websearch",
  actions: 1,
  write: 0,
});
