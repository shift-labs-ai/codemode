/**
 * What a plugin that routes to one of several providers shares: one
 * connection that holds a key per provider, each key sent to its own
 * provider alone, and the connection's choice of which provider a request
 * goes to.
 */

import * as t from "typebox";
import { staticCredential } from "./plugin.js";
import type { CredentialDeclaration, CredentialTarget } from "./types.js";

/** A provider a plugin routes to: its name, and where its key comes from and goes. */
export interface RoutedProvider {
  /** The name a connection gives as its `provider`, and the stem of the key's connection field. */
  name: string;
  /** The environment variable that fills the key. */
  env: string;
  /** Where the key goes in a request: a header, or a query parameter. */
  key: { header: string; prefix?: string } | { query: string };
}

type Config = Readonly<Record<string, unknown>>;

/** The connection field that holds a provider's key. */
export function providerKeyField(provider: RoutedProvider): string {
  return `${provider.name}ApiKey`;
}

/** Whether the connection holds a key for the provider. */
function hasKey(provider: RoutedProvider, config: Config): boolean {
  return Boolean(config[providerKeyField(provider)]);
}

/**
 * One credential for every provider: a part per provider, each optional and
 * each placed only on that provider's targets, so a connection holds the
 * keys it has and a key is sent to its own provider alone. `targets` gives a
 * provider's targets by name; the names are no other provider's and do not
 * depend on the connection's config.
 */
export function routerCredential<P extends RoutedProvider>(
  id: string,
  providers: readonly P[],
  targets: (provider: P, config: Config) => Record<string, CredentialTarget>,
): CredentialDeclaration {
  const names = providers.map((provider) => provider.name);
  return staticCredential({
    id,
    auth: {
      kind: "static",
      parts: names,
      optionalParts: names,
      placements: providers.map((provider) => {
        const { name, key } = provider;
        const own = Object.keys(targets(provider, {}));
        return "query" in key
          ? { in: "query", part: name, name: key.query, targets: own }
          : {
              in: "header",
              part: name,
              name: key.header,
              ...(key.prefix === undefined ? {} : { prefix: key.prefix }),
              targets: own,
            };
      }),
    },
    local: Object.fromEntries(
      providers.map((provider) => [provider.name, providerKeyField(provider)]),
    ),
    targets: (config) =>
      Object.assign({}, ...providers.map((one) => targets(one, config))),
  });
}

/**
 * The connection fields every routing plugin has: `provider`, described by
 * `choice`, and an optional key per provider, filled from its environment
 * variable.
 */
export function routerConnectionFields(
  providers: readonly RoutedProvider[],
  choice: string,
) {
  return {
    provider: t.Optional(
      t.String({
        enum: providers.map((provider) => provider.name),
        description: choice,
      }),
    ),
    ...Object.fromEntries(
      providers.map((provider) => [
        providerKeyField(provider),
        t.Optional(
          t.String({
            env: provider.env,
            description: `API key for ${provider.name}`,
          }),
        ),
      ]),
    ),
  };
}

/**
 * The provider the connection names as its `provider`, or nothing when it
 * names none. A host that signs requests keeps the keys, so only a
 * connection that signs for itself (`signsItself`) is asked to hold the key
 * of the provider it names.
 */
export function namedProvider<P extends RoutedProvider>(
  plugin: string,
  providers: readonly P[],
  config: Config,
  signsItself: boolean,
): P | undefined {
  const name = config.provider;
  if (name === undefined) return undefined;
  const provider = providers.find((candidate) => candidate.name === name);
  if (!provider)
    throw new Error(
      `${plugin}: the connection names the provider ${JSON.stringify(name)}. The providers are ${providers.map((candidate) => candidate.name).join(", ")}.`,
    );
  if (signsItself && !hasKey(provider, config))
    throw new Error(
      `${plugin}: no key for ${provider.name}, the connection's provider. Set ${provider.env}.`,
    );
  return provider;
}

/**
 * The providers the connection holds a key for, in the plugin's order: the
 * candidates when the connection names no provider. `kind` says what the
 * providers are in the error when there is none, such as `search`.
 */
export function keyedProviders<P extends RoutedProvider>(
  plugin: string,
  kind: string,
  providers: readonly P[],
  config: Config,
): P[] {
  const keyed = providers.filter((candidate) => hasKey(candidate, config));
  if (!keyed.length)
    throw new Error(
      `${plugin}: no ${kind} provider has a key. Set one of ${providers.map((candidate) => candidate.env).join(", ")}, or the connection's "provider" when the host keeps the keys.`,
    );
  return keyed;
}
