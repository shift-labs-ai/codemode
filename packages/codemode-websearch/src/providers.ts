/**
 * The search providers: for each, where its key goes, the request a search
 * becomes, and how its answer reads as results. A provider is data and two
 * pure functions; the plugin sends the request.
 */

import { httpsBase } from "@shiftlabs/codemode";
import * as t from "typebox";

/** A search as every provider receives it. */
export interface SearchRequest {
  query: string;
  /** The most results wanted. The plugin returns no more, whatever a provider answers. */
  numResults: number;
  /** Two-letter country code, lower case. */
  country?: string;
  /** Two-letter language code, lower case. */
  language?: string;
}

/** One result, in the shape every provider's answer is read into. */
export interface SearchResult {
  title: string;
  url: string;
  /** The text the provider returned for the page: a snippet, excerpts or the page itself. */
  content: string;
  publishedDate?: string;
  author?: string;
  sourceType?: string;
}

/** A search API: where it is, where its key goes, and how a search reads to and from it. */
export interface SearchProvider {
  /** The name code passes as `provider`, and the stem of the key's connection field. */
  name: string;
  /** The environment variable that fills the key. */
  env: string;
  /** Where the key goes in a request: a header, or a query parameter. */
  key: { header: string; prefix?: string } | { query: string };
  /**
   * The HTTPS address the key may be sent beneath, ending in `/`: fixed, or
   * from the connection's config.
   */
  baseUrl: string | ((config: Readonly<Record<string, unknown>>) => string);
  /** Connection fields of the provider's own, beside its key. */
  fields?: Record<string, t.TSchema>;
  /** How a search is sent: parameters in the query of a GET, or the JSON body of a POST. */
  method: "GET" | "POST";
  /** The path of the search endpoint beneath `baseUrl`. */
  path: string;
  /** Headers every request carries. */
  headers?: Record<string, string>;
  /** The provider's parameters for a search, under the names its API gives them. */
  params(search: SearchRequest): Record<string, unknown>;
  /** The results in the provider's answer. */
  results(answer: unknown): SearchResult[];
}

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The strings among `parts`, joined as paragraphs. */
function paragraphs(...parts: unknown[]): string {
  return parts.flat().filter(text).join("\n\n");
}

/** A result, with each optional field the provider gave as a string. */
function result(fields: {
  title: string;
  url: string;
  content: string;
  publishedDate?: unknown;
  author?: unknown;
  sourceType?: unknown;
}): SearchResult {
  const { title, url, content } = fields;
  const found: SearchResult = { title, url, content };
  for (const name of ["publishedDate", "author", "sourceType"] as const) {
    const value = text(fields[name]);
    if (value) found[name] = value;
  }
  return found;
}

/**
 * What a Google results page says about the thing searched for, as a first
 * result: Serper and SerpAPI return it beside the links.
 */
function knowledgeGraph(graph: unknown): SearchResult[] {
  const { title, description } = object(graph);
  return text(description)
    ? [
        {
          title: `Knowledge Graph: ${text(title)}`,
          url: "",
          content: text(description),
        },
      ]
    : [];
}

const upper = (code?: string) => code?.toUpperCase();

export const parallel: SearchProvider = {
  name: "parallel",
  env: "PARALLEL_API_KEY",
  key: { header: "x-api-key" },
  baseUrl: "https://api.parallel.ai/v1/",
  method: "POST",
  path: "search",
  params: ({ query, numResults, country }) => ({
    objective: query,
    search_queries: [query],
    mode: "fast",
    advanced_settings: { max_results: numResults, location: country },
  }),
  results: (answer) =>
    list(object(answer).results).map((r) =>
      result({
        title: text(r.title) || text(r.url),
        url: text(r.url),
        content: paragraphs(r.excerpts),
        publishedDate: r.publish_date,
      }),
    ),
};

export const brave: SearchProvider = {
  name: "brave",
  env: "BRAVE_API_KEY",
  key: { header: "X-Subscription-Token" },
  baseUrl: "https://api.search.brave.com/res/v1/",
  method: "GET",
  path: "web/search",
  params: ({ query, numResults, country, language }) => ({
    q: query,
    count: numResults,
    country: upper(country),
    search_lang: language,
  }),
  results: (answer) =>
    list(object(object(answer).web).results).map((r) =>
      result({
        title: text(r.title),
        url: text(r.url),
        content: paragraphs(r.description, r.extra_snippets),
        publishedDate: r.page_age,
      }),
    ),
};

export const exa: SearchProvider = {
  name: "exa",
  env: "EXA_API_KEY",
  key: { header: "x-api-key" },
  baseUrl: "https://api.exa.ai/",
  method: "POST",
  path: "search",
  params: ({ query, numResults, country }) => ({
    query,
    numResults,
    type: "auto",
    contents: { text: { maxCharacters: 3000 }, highlights: true },
    userLocation: upper(country),
  }),
  results: (answer) =>
    list(object(answer).results).map((r) =>
      result({
        title: text(r.title) || text(r.url),
        url: text(r.url),
        content: paragraphs(r.text, r.highlights),
        publishedDate: r.publishedDate,
        author: r.author,
      }),
    ),
};

export const you: SearchProvider = {
  name: "you",
  env: "YOU_API_KEY",
  key: { header: "X-API-Key" },
  baseUrl: "https://ydc-index.io/v1/",
  method: "POST",
  path: "search",
  params: ({ query, numResults, country, language }) => ({
    query,
    count: numResults,
    country: upper(country),
    language: upper(language),
  }),
  results: (answer) =>
    list(object(object(answer).results).web).map((r) =>
      result({
        title: text(r.title),
        url: text(r.url),
        content:
          paragraphs(object(r.contents).highlights) ||
          paragraphs(r.snippets) ||
          text(r.description),
        publishedDate: r.page_age,
      }),
    ),
};

export const tavily: SearchProvider = {
  name: "tavily",
  env: "TAVILY_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.tavily.com/",
  method: "POST",
  path: "search",
  // Tavily takes a country by its English name, so a country code is not sent.
  params: ({ query, numResults, language }) => ({
    query,
    max_results: numResults,
    search_depth: "basic",
    language,
  }),
  results: (answer) =>
    list(object(answer).results).map((r) =>
      result({
        title: text(r.title),
        url: text(r.url),
        content: text(r.content),
        publishedDate: r.published_date,
      }),
    ),
};

const FIRECRAWL = "https://api.firecrawl.dev";

export const firecrawl: SearchProvider = {
  name: "firecrawl",
  env: "FIRECRAWL_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  baseUrl: (config) => httpsBase(config.firecrawlUrl ?? FIRECRAWL, "v2/"),
  method: "POST",
  fields: {
    firecrawlUrl: t.Optional(
      t.String({
        env: "FIRECRAWL_URL",
        description: `A Firecrawl of your own, by its HTTPS address. The default is ${FIRECRAWL}`,
      }),
    ),
  },
  path: "search",
  params: ({ query, numResults, country }) => ({
    query,
    limit: numResults,
    country: upper(country),
  }),
  results: (answer) =>
    list(object(object(answer).data).web).map((r) =>
      result({
        title: text(r.title) || text(r.url),
        url: text(r.url),
        content: text(r.markdown) || text(r.description),
      }),
    ),
};

export const jina: SearchProvider = {
  name: "jina",
  env: "JINA_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  baseUrl: "https://s.jina.ai/",
  method: "POST",
  path: "",
  headers: { "X-Retain-Images": "none" },
  params: ({ query, numResults, country, language }) => ({
    q: query,
    num: numResults,
    gl: country,
    hl: language,
  }),
  results: (answer) =>
    list(object(answer).data).map((r) =>
      result({
        title: text(r.title),
        url: text(r.url),
        content: text(r.content) || text(r.description),
      }),
    ),
};

export const linkup: SearchProvider = {
  name: "linkup",
  env: "LINKUP_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.linkup.so/v1/",
  method: "POST",
  path: "search",
  params: ({ query, numResults }) => ({
    q: query,
    depth: "standard",
    outputType: "searchResults",
    includeImages: false,
    maxResults: numResults,
  }),
  results: (answer) =>
    list(object(answer).results).map((r) =>
      result({
        title: text(r.name),
        url: text(r.url),
        content: text(r.content),
      }),
    ),
};

export const valyu: SearchProvider = {
  name: "valyu",
  env: "VALYU_API_KEY",
  key: { header: "X-API-Key" },
  baseUrl: "https://api.valyu.ai/v1/",
  method: "POST",
  path: "search",
  params: ({ query, numResults, country }) => ({
    query,
    search_type: "all",
    max_num_results: numResults,
    country_code: upper(country),
  }),
  results: (answer) =>
    list(object(answer).results).map((r) =>
      result({
        title: text(r.title),
        url: text(r.url),
        content: text(r.content),
        publishedDate: r.publication_date,
        sourceType: r.source_type,
      }),
    ),
};

export const perplexity: SearchProvider = {
  name: "perplexity",
  env: "PERPLEXITY_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.perplexity.ai/",
  method: "POST",
  path: "search",
  params: ({ query, numResults, country, language }) => ({
    query,
    max_results: numResults,
    country: upper(country),
    search_language_filter: language ? [language] : undefined,
  }),
  results: (answer) =>
    list(object(answer).results).map((r) =>
      result({
        title: text(r.title),
        url: text(r.url),
        content: text(r.snippet),
        publishedDate: r.date,
      }),
    ),
};

export const serper: SearchProvider = {
  name: "serper",
  env: "SERPER_API_KEY",
  key: { header: "X-API-KEY" },
  baseUrl: "https://google.serper.dev/",
  method: "POST",
  path: "search",
  params: ({ query, numResults, country, language }) => ({
    q: query,
    num: numResults,
    gl: country,
    hl: language,
  }),
  results: (answer) => [
    ...knowledgeGraph(object(answer).knowledgeGraph),
    ...list(object(answer).organic).map((r) =>
      result({
        title: text(r.title),
        url: text(r.link),
        content: text(r.snippet),
        publishedDate: r.date,
      }),
    ),
  ],
};

export const serpapi: SearchProvider = {
  name: "serpapi",
  env: "SERPAPI_API_KEY",
  key: { query: "api_key" },
  baseUrl: "https://serpapi.com/",
  method: "GET",
  path: "search.json",
  // SerpAPI's Google search takes no number of results: it answers a page.
  params: ({ query, country, language }) => ({
    q: query,
    engine: "google",
    gl: country,
    hl: language,
  }),
  results: (answer) => [
    ...knowledgeGraph(object(answer).knowledge_graph),
    ...list(object(answer).organic_results).map((r) =>
      result({
        title: text(r.title),
        url: text(r.link),
        content: text(r.snippet),
        publishedDate: r.date,
      }),
    ),
  ],
};

/**
 * Every provider, in the order one is chosen when a search names none:
 * providers with an index of their own, then those that read pages for a
 * search, then those that return Google's results.
 */
export const PROVIDERS: SearchProvider[] = [
  parallel,
  brave,
  exa,
  you,
  tavily,
  firecrawl,
  jina,
  linkup,
  valyu,
  perplexity,
  serper,
  serpapi,
];
