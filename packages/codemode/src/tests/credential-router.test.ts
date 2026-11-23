import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  keyedProviders,
  namedProvider,
  providerKeyField,
  type RoutedProvider,
  routerConnectionFields,
  routerCredential,
} from "../credentials/router.js";
import type { CredentialTarget } from "../credentials/types.js";
import { connectionFields } from "../plugin/schema.js";

const acme: RoutedProvider = {
  name: "acme",
  env: "ACME_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
};
const globex: RoutedProvider = {
  name: "globex",
  env: "GLOBEX_API_KEY",
  key: { query: "api_key" },
};
const PROVIDERS = [acme, globex];
/** acme has two targets, globex one whose address comes from the connection. */
const targets = (
  { name }: RoutedProvider,
  config: Readonly<Record<string, unknown>>,
): Record<string, CredentialTarget> =>
  name === "acme"
    ? {
        acme: { baseUrl: "https://api.acme.example/", methods: ["POST"] },
        acmeFiles: { baseUrl: "https://files.acme.example/", methods: ["GET"] },
      }
    : {
        globex: {
          baseUrl: `https://${config.region ?? "us"}.globex.example/`,
          methods: ["GET"],
        },
      };

describe("routerCredential", () => {
  const selection = routerCredential(
    "acmeOrGlobex",
    PROVIDERS,
    targets,
  )({ region: "eu" });
  const method = selection.type.methods[selection.method];

  it("declares every provider's targets, each from the connection's config", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(method.targets).map(([name, target]) => [
          name,
          target.baseUrl,
        ]),
      ),
      {
        acme: "https://api.acme.example/",
        acmeFiles: "https://files.acme.example/",
        globex: "https://eu.globex.example/",
      },
    );
  });

  it("makes every key optional, and places each on its own provider's targets alone", () => {
    assert.deepEqual(method.authentication, {
      kind: "static",
      field: "credential",
      parts: ["acme", "globex"],
      optionalParts: ["acme", "globex"],
      placements: [
        {
          in: "header",
          part: "acme",
          name: "Authorization",
          prefix: "Bearer ",
          targets: ["acme", "acmeFiles"],
        },
        { in: "query", part: "globex", name: "api_key", targets: ["globex"] },
      ],
    });
  });
});

describe("the connection of a plugin that routes", () => {
  it("has a provider field and a key per provider, filled from its environment variable", () => {
    const fields = connectionFields({
      type: "object",
      properties: routerConnectionFields(PROVIDERS, "Which provider"),
    } as never);
    assert.deepEqual(Object.keys(fields), [
      "provider",
      "acmeApiKey",
      "globexApiKey",
    ]);
    assert.equal(fields.provider.description, "Which provider");
    assert.equal(fields.globexApiKey.env, "GLOBEX_API_KEY");
    assert.equal(fields.globexApiKey.required, false);
    assert.equal(providerKeyField(globex), "globexApiKey");
  });

  it("names its provider, which needs a key only where the connection signs for itself", () => {
    assert.equal(namedProvider("p", PROVIDERS, {}, true), undefined);
    assert.equal(
      namedProvider("p", PROVIDERS, { provider: "globex" }, false),
      globex,
    );
    assert.equal(
      namedProvider(
        "p",
        PROVIDERS,
        { provider: "globex", globexApiKey: "g" },
        true,
      ),
      globex,
    );
    assert.throws(
      () => namedProvider("p", PROVIDERS, { provider: "globex" }, true),
      {
        message:
          "p: no key for globex, the connection's provider. Set GLOBEX_API_KEY.",
      },
    );
    assert.throws(
      () => namedProvider("p", PROVIDERS, { provider: "initech" }, false),
      {
        message:
          'p: the connection names the provider "initech". The providers are acme, globex.',
      },
    );
  });

  it("offers the providers it holds a key for, in order, or says which keys to set", () => {
    assert.deepEqual(
      keyedProviders("p", "search", PROVIDERS, {
        globexApiKey: "g",
        acmeApiKey: "a",
      }),
      [acme, globex],
    );
    assert.deepEqual(
      keyedProviders("p", "search", PROVIDERS, { globexApiKey: "g" }),
      [globex],
    );
    assert.throws(() => keyedProviders("p", "search", PROVIDERS, {}), {
      message:
        'p: no search provider has a key. Set one of ACME_API_KEY, GLOBEX_API_KEY, or the connection\'s "provider" when the host keeps the keys.',
    });
  });
});
