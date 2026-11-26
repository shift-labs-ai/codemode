import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CredentialBroker } from "../credentials/transport.js";

/** One request a plugin sent while it was being linted. */
export interface SentRequest {
  /** `credential`: through the credential layer. `fetch`: around it. */
  via: "credential" | "fetch";
  /** The action that sent it, or `undefined` while the module loaded. */
  action?: string;
  method: string;
  /** The target's name for `credential`, the URL for `fetch`. */
  to: string;
  path?: string;
  headers: Record<string, string>;
  body: string;
}

/** The address the stand-in network answers for: an address field's value, and every socket URL. */
export const STAND_IN_HOST = "codemode-lint.invalid";

/** What one stand-in saw. */
export interface StandInRecord {
  requests: SentRequest[];
  /**
   * Environment variables the package's own code read, by the action that
   * read them (`""` while the module loaded); `*` for all of them.
   */
  envReads: Map<string, Set<string>>;
}

const EMPTY_JSON = () =>
  new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Stand in for the network and the environment while a package's code
 * runs, and record what it does with them.
 *
 * Every request answers `{}` and leaves the machine through neither the
 * credential layer nor `fetch`. A read of `process.env` is recorded when
 * its caller is a file of the package outside its `node_modules`, compared
 * by real path. A read a dependency or the module loader makes, even on the
 * plugin's behalf, is not counted against the plugin.
 *
 * The stand-in replaces `globalThis.fetch` and `process.env` for the whole
 * process until `stop()`. Run it in a process of its own: other code in
 * that process would be recorded too, and would get no network.
 */
export function startStandIn(packageDir: string): {
  record: StandInRecord;
  /** The broker an action's `ctx.credentials` is given. */
  broker(action: string): CredentialBroker;
  /** Name the action whose calls follow. */
  running(action: string | undefined): void;
  stop(): void;
} {
  const root = withSep(realpathSync(packageDir));
  const record: StandInRecord = { requests: [], envReads: new Map() };
  let current: string | undefined;

  const realFetch = globalThis.fetch;
  const realEnv = process.env;
  const realPaths = new Map<string, string>();
  const real = (file: string) => {
    let resolved = realPaths.get(file);
    if (resolved === undefined) {
      try {
        resolved = realpathSync(file);
      } catch {
        resolved = file;
      }
      realPaths.set(file, resolved);
    }
    return resolved;
  };
  const self = real(fileURLToPath(import.meta.url));
  const readEnv = (key: string) => {
    const by = current ?? "";
    const keys = record.envReads.get(by) ?? new Set<string>();
    keys.add(key);
    record.envReads.set(by, keys);
  };
  const fromPackage = (): boolean => {
    const frames = (new Error().stack ?? "").split("\n").slice(1);
    for (const frame of frames) {
      const file = frame
        .match(/\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?\s*$/)?.[1]
        ?.replace(/^file:\/\//, "");
      if (!file) continue;
      const resolved = real(file);
      if (resolved === self) continue;
      return (
        resolved.startsWith(root) &&
        !resolved.includes(`${sep}node_modules${sep}`)
      );
    }
    return false;
  };

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
    record.requests.push({
      via: "fetch",
      action: current,
      method: request.method,
      to: request.url,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return EMPTY_JSON();
  }) as typeof fetch;

  process.env = new Proxy(realEnv, {
    get(target, key) {
      if (typeof key === "string" && fromPackage()) readEnv(key);
      return Reflect.get(target, key);
    },
    ownKeys(target) {
      if (fromPackage()) readEnv("*");
      return Reflect.ownKeys(target);
    },
  });

  return {
    record,
    broker(action) {
      return {
        async request(input) {
          const body = input.body;
          record.requests.push({
            via: "credential",
            action,
            method: input.method ?? "GET",
            to: input.target,
            path: input.path,
            headers: { ...input.headers },
            body:
              typeof body === "string"
                ? body
                : body
                  ? new TextDecoder().decode(body)
                  : "",
          });
          return EMPTY_JSON();
        },
        async probe() {
          return { outcome: "unverified" };
        },
        async socketUrl() {
          return `wss://${STAND_IN_HOST}/`;
        },
      };
    },
    running(action) {
      current = action;
    },
    stop() {
      globalThis.fetch = realFetch;
      process.env = realEnv;
    },
  };
}

function withSep(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}
