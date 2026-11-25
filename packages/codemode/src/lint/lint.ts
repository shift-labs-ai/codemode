import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Create } from "typebox/value";
import {
  bundledPluginNames,
  type PluginReport,
  reportPlugin,
} from "../packages/manager.js";
import { readPackageManifest } from "../packages/manifest.js";
import { loadPluginFromPath } from "../plugin/loader.js";
import {
  connectionFields,
  isTypedInputSchema,
  legacyFields,
} from "../plugin/schema.js";
import type { ActionContext, PluginDef } from "../plugin/types.js";
import { STAND_IN_HOST, type StandInRecord, startStandIn } from "./stand-in.js";
import { accessProblem } from "./verbs.js";

export type LintLevel = "error" | "warning";

/** One thing `lintPackage` found. `rule` is stable; `message` says what to do. */
export interface LintFinding {
  rule: string;
  level: LintLevel;
  message: string;
  /** The plugin it concerns, or absent for the package itself. */
  plugin?: string;
  /** The actions it concerns, by their names inside the plugin. */
  actions?: string[];
  /** Why the package allows this rule, when it declares an exemption; the finding is then a warning. */
  allowed?: string;
  /** A file relative to the package, with its line when one is known. */
  file?: string;
  line?: number;
}

/** What one plugin of the package declares, as `codemode install` reports it, and where it sent. */
export type LintedPlugin = PluginReport & {
  /** Every host its requests went to while it was linted, and every host its credential is declared for. */
  hosts: string[];
};

export interface LintReport {
  /** No finding is an error. */
  ok: boolean;
  findings: LintFinding[];
  plugins: LintedPlugin[];
}

export interface LintOptions {
  /**
   * Names a plugin cannot take. Default: the bundled plugins' names, which
   * select their connections and so their credentials.
   */
  reservedNames?: ReadonlySet<string>;
  /** How long one action may run against the stand-in network. Default 3 s. */
  actionTimeoutMs?: number;
}

/** A header that carries a login, whatever its value. */
const CREDENTIAL_HEADER =
  /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)$/i;
/** A connection field that holds a secret by its name. */
const SECRET_FIELD =
  /(key|token|secret|password|passwd|passphrase|cookie|session|credential)s?$/i;
/** A connection field that holds an address by its name. */
const ADDRESS_FIELD = /(url|uri|host|hostname|domain|endpoint|origin|server)$/i;
/** Text that is a credential wherever it appears. */
const SECRET_LITERAL =
  /(sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
/**
 * An Authorization header whose value is built from a variable: a template,
 * a concatenation, or a bare identifier. A credential declaration's
 * `header: "Authorization"` names the header and is not one.
 */
const BUILT_AUTH_HEADER =
  /["'`]?(proxy-)?authorization["'`]?\s*:\s*(`[^`]*\$\{|["'][^"']*["']\s*\+|[A-Za-z_$][\w$.]*\s*[,}])/i;
/**
 * Environment variables that only locate the operating system's own
 * programs. A shell plugin reads them to find its shell; they hold no
 * configuration and no secret.
 */
const OS_LOCATIONS = new Set([
  "SystemRoot",
  "windir",
  "ComSpec",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PATH",
  "Path",
  "PATHEXT",
]);
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
/**
 * Methods a read never sends. POST is not among them: searches, GraphQL
 * queries and logins read with it.
 */
const WRITE_METHODS = new Set(["PUT", "PATCH", "DELETE"]);
const SOURCE_FILE = /\.(c|m)?(j|t)sx?$/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/**
 * Check a plugin package against what a plugin must be to run for other
 * people: its files, what it registers when it loads, and what its actions
 * send when they run.
 *
 * Loading and running execute the package's code. Every request answers
 * `{}` and reaches no network. The code runs in a temporary working
 * directory, removed afterwards, so a file it writes by a relative path
 * goes there; nothing else on the machine is fenced. The run replaces
 * `globalThis.fetch`, `process.env` and the working directory while it
 * lasts, so a host runs it in a process of its own (`codemode lint --json`).
 */
export async function lintPackage(
  packageDir: string,
  options: LintOptions = {},
): Promise<LintReport> {
  const dir = resolve(packageDir);
  const findings: LintFinding[] = [];
  const add = (finding: LintFinding) => findings.push(finding);
  const reserved = options.reservedNames ?? bundledPluginNames();

  // ── files ──────────────────────────────────────────────
  const pkg = readJson(join(dir, "package.json"));
  for (const script of INSTALL_SCRIPTS)
    if (typeof pkg?.scripts?.[script] === "string")
      add({
        rule: "package/install-script",
        level: "error",
        file: "package.json",
        message: `Remove the "${script}" script: codemode never runs install scripts, so the package must work without it`,
      });
  for (const file of sourceFiles(dir)) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    lines.forEach((text, index) => {
      // A comment may show a header as an example; a secret is leaked wherever it is written.
      if (!COMMENT_LINE.test(text) && BUILT_AUTH_HEADER.test(text))
        add({
          rule: "source/auth-header",
          level: "error",
          file,
          line: index + 1,
          message:
            "Stop building the Authorization header; declare the credential and send through credentialJson, which places the secret",
        });
      if (SECRET_LITERAL.test(text))
        add({
          rule: "source/secret-literal",
          level: "error",
          file,
          line: index + 1,
          message:
            "Remove the secret from the code; it belongs in a connection field the user fills",
        });
    });
  }

  let manifest: ReturnType<typeof readPackageManifest>;
  try {
    manifest = readPackageManifest(dir, dir);
  } catch (error) {
    add({ rule: "load/failed", level: "error", message: messageOf(error) });
    return report(findings, [], allowances(pkg));
  }
  for (const module of manifest.bundledHostModules)
    add({
      rule: "package/host-module-dependency",
      level: "error",
      file: "package.json",
      message: `Move ${module} from dependencies to peerDependencies with "*": codemode supplies it`,
    });
  for (const peer of manifest.unsatisfiedPeers)
    add({
      rule: "package/peer-range",
      level: "warning",
      file: "package.json",
      message: `${peer.module} ${peer.range} excludes the ${peer.version} that loads it`,
    });

  // ── load and run ───────────────────────────────────────
  const scratchDir = mkdtempSync(join(tmpdir(), "codemode-lint-"));
  const callerDir = process.cwd();
  let standIn: ReturnType<typeof startStandIn> | undefined;
  const plugins: LintedPlugin[] = [];
  try {
    process.chdir(scratchDir);
    standIn = startStandIn(dir);
    for (const path of manifest.pluginPaths) {
      standIn.record.requests.length = 0;
      standIn.record.envReads.clear();
      const file = relative(dir, path) || path;
      let plugin: PluginDef;
      try {
        plugin = await loadPluginFromPath(path, {
          defaultName: null,
          diskCache: false,
        });
      } catch (error) {
        add({
          rule: "load/failed",
          level: "error",
          file,
          message: messageOf(error),
        });
        continue;
      }
      const connection = standInConnection(plugin);
      const declared = reportPlugin(plugin, connection.config);
      checkDeclarations(plugin, declared, reserved, add);
      const notRun = await runActions(plugin, connection.config, standIn, {
        outputDir: scratchDir,
        timeoutMs: options.actionTimeoutMs ?? 3_000,
      });
      if (notRun.length > 0)
        add({
          plugin: plugin.name,
          actions: notRun,
          rule: "run/not-run",
          level: "warning",
          message:
            "Not run, so what it sends is unchecked: no input could be made for its schema; give each string with a pattern or format a default",
        });
      plugins.push({
        ...declared,
        hosts: checkRequests(
          plugin,
          declared,
          connection.secrets,
          standIn.record,
          add,
        ),
      });
      checkEnvReads(plugin.name, standIn.record, add);
    }
  } finally {
    standIn?.stop();
    process.chdir(callerDir);
    rmSync(scratchDir, { recursive: true, force: true });
  }
  return report(findings, plugins, allowances(pkg));
}

/**
 * The report: one finding per cause, with every action it concerns, and a
 * rule the package allows turned into a warning that says why.
 */
function report(
  findings: LintFinding[],
  plugins: LintedPlugin[],
  allowed: ReadonlyMap<string, string> = new Map(),
): LintReport {
  const merged = new Map<string, LintFinding>();
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.rule,
      finding.plugin,
      finding.file,
      finding.line,
      finding.message,
    ]);
    const existing = merged.get(key);
    if (existing && finding.actions)
      existing.actions = [
        ...new Set([...(existing.actions ?? []), ...finding.actions]),
      ];
    else if (!existing) {
      const reason = allowed.get(finding.rule);
      merged.set(
        key,
        reason === undefined
          ? { ...finding }
          : { ...finding, level: "warning", allowed: reason },
      );
    }
  }
  const all = [...merged.values()];
  return {
    ok: !all.some((f) => f.level === "error"),
    findings: all,
    plugins,
  };
}

/**
 * The rules a package allows, each with its reason, from
 * `"codemode": { "lint": { "allow": { "<rule>": "<why>" } } }` in its
 * package.json. A rule without a reason is not allowed.
 */
function allowances(pkg: PackageJson | undefined): Map<string, string> {
  const allow = pkg?.codemode?.lint?.allow;
  const allowed = new Map<string, string>();
  if (allow && typeof allow === "object")
    for (const [rule, reason] of Object.entries(allow))
      if (typeof reason === "string" && reason.trim())
        allowed.set(rule, reason.trim());
  return allowed;
}

/** What a plugin says about itself once loaded. */
function checkDeclarations(
  plugin: PluginDef,
  declared: PluginReport,
  reserved: ReadonlySet<string>,
  add: (finding: LintFinding) => void,
): void {
  const at = { plugin: plugin.name };
  if (reserved.has(plugin.name))
    add({
      ...at,
      rule: "name/reserved",
      level: "error",
      message: `Rename the plugin: "${plugin.name}" is a bundled plugin's name`,
    });
  if (plugin.actions.length === 0)
    add({
      ...at,
      rule: "plugin/no-actions",
      level: "error",
      message: "Register at least one action",
    });

  for (const action of plugin.actions) {
    const here = { ...at, actions: [action.name] };
    const access = accessProblem(action);
    if (access?.kind === "undeclared")
      add({
        ...here,
        rule: "action/access",
        level: "error",
        message: 'Declare access: "read" or "write"',
      });
    else if (access?.kind === "mutating-read")
      add({
        ...here,
        rule: "action/access-verb",
        level: "error",
        message: `"${access.verb}" changes something, so access must be "write"`,
      });
    if (!action.description?.trim())
      add({
        ...here,
        rule: "action/description",
        level: "error",
        message: "Describe what the action does, in one sentence",
      });
    if (isTypedInputSchema(action.inputSchema)) {
      const schema = action.inputSchema as {
        type?: unknown;
        additionalProperties?: unknown;
      };
      if (schema.type === "object" && schema.additionalProperties !== false)
        add({
          ...here,
          rule: "action/input-open",
          level: "error",
          message:
            "Set additionalProperties: false on the input, so a misspelled field fails instead of being ignored",
        });
    } else if (action.inputSchema)
      add({
        ...here,
        rule: "action/input-legacy",
        level: "warning",
        message: "Write the input as a TypeBox object",
      });
  }

  for (const url of declared.credential?.targets ?? [])
    if (!/^(https|wss):\/\//.test(url))
      add({
        ...at,
        rule: "credential/insecure-target",
        level: "error",
        message: `The credential is declared for ${url}; send it over https or wss only`,
      });
  if (declared.credentialNote)
    add({
      ...at,
      rule: "credential/unresolved",
      level: "warning",
      message:
        "The credential chooses its targets from connection config the stand-in values do not satisfy, so they are not checked for https or wss",
    });
  const secrets = Object.keys(
    connectionFields(plugin.connectionConfigSchema),
  ).filter((f) => SECRET_FIELD.test(f));
  if (secrets.length > 0 && !plugin.credential && !plugin.oauth)
    add({
      ...at,
      rule: "credential/undeclared",
      level: "warning",
      message: `${secrets.join(", ")} look like secrets, but the plugin declares no credential; declare one and send through credentialJson`,
    });
}

/**
 * A connection config the actions can run with: an address for each
 * address field, a value no real secret has for each secret field, and a
 * plain value for the rest. A credential that resolves says which fields
 * are its secret; otherwise a field is a secret by its name.
 */
function standInConnection(plugin: PluginDef): {
  config: Record<string, unknown>;
  secrets: Map<string, string>;
} {
  const fields = connectionFields(plugin.connectionConfigSchema);
  const build = (isSecret: (name: string) => boolean) => {
    const config: Record<string, unknown> = {};
    const secrets = new Map<string, string>();
    for (const [name, field] of Object.entries(fields)) {
      if (ADDRESS_FIELD.test(name)) config[name] = `https://${STAND_IN_HOST}`;
      else if (isSecret(name)) {
        const sentinel = `codemode-lint-secret-${name}`;
        config[name] = sentinel;
        secrets.set(sentinel, name);
      } else config[name] = standInValue(field);
    }
    return { config, secrets };
  };
  const byName = build((name) => SECRET_FIELD.test(name));
  const declared = declaredSecretFields(plugin, byName.config);
  return declared ? build((name) => declared.has(name)) : byName;
}

async function runActions(
  plugin: PluginDef,
  config: Record<string, unknown>,
  standIn: ReturnType<typeof startStandIn>,
  { outputDir, timeoutMs }: { outputDir: string; timeoutMs: number },
): Promise<string[]> {
  const notRun: string[] = [];
  for (const action of plugin.actions) {
    const input = inputFor(action.inputSchema);
    if (input === undefined) {
      notRun.push(action.name);
      continue;
    }
    const controller = new AbortController();
    const ctx: ActionContext = {
      connection: {
        name: plugin.name,
        plugin: plugin.name,
        config: { ...config },
      },
      credentials: standIn.broker(action.name),
      signal: controller.signal,
      outputDir,
      log: { info() {}, warn() {}, error() {} },
      async updateConnection() {},
    };
    standIn.running(action.name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // An action answering the stand-in `{}` may fail on its shape; only what it sent is judged.
      await Promise.race([
        Promise.resolve().then(() => action.execute(input, ctx)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      controller.abort();
      standIn.running(undefined);
    }
  }
  return notRun;
}

/**
 * What a plugin's requests did with its secrets and its labels. Answers
 * every host they went to, with the hosts its credential is declared for.
 */
function checkRequests(
  plugin: PluginDef,
  declared: PluginReport,
  secrets: Map<string, string>,
  record: StandInRecord,
  add: (finding: LintFinding) => void,
): string[] {
  const hosts = new Set((declared.credential?.targets ?? []).map(hostOf));
  const readsSending = new Set<string>();
  for (const request of record.requests) {
    const at = {
      plugin: plugin.name,
      ...(request.action ? { actions: [request.action] } : {}),
    };
    if (request.via === "fetch") hosts.add(hostOf(request.to));
    const text = [
      request.to,
      request.path ?? "",
      ...Object.values(request.headers),
      request.body,
    ].join("\n");
    for (const [sentinel, field] of secrets)
      if (text.includes(sentinel))
        add({
          ...at,
          rule: "run/secret-outside-credential",
          level: "error",
          message: `Sends the connection's ${field} by hand; declare it in the credential and send through credentialJson, which places it`,
        });
    if (request.via === "fetch")
      for (const header of Object.keys(request.headers))
        if (CREDENTIAL_HEADER.test(header))
          add({
            ...at,
            rule: "run/secret-outside-credential",
            level: "error",
            message: `Sends the ${header.toLowerCase()} header around the credential layer; declare the credential and send through credentialJson`,
          });
    const action = plugin.actions.find((a) => a.name === request.action);
    if (
      action?.access === "read" &&
      WRITE_METHODS.has(request.method.toUpperCase())
    )
      readsSending.add(action.name);
  }
  if (readsSending.size > 0)
    add({
      plugin: plugin.name,
      rule: "run/read-sends-write",
      level: "warning",
      message: `${[...readsSending].join(", ")} ${readsSending.size === 1 ? "is" : "are"} labelled read but send PUT, PATCH or DELETE; label each write`,
    });
  return [...hosts]
    .map((host) =>
      host === STAND_IN_HOST ? "(a host from the connection)" : host,
    )
    .filter(Boolean)
    .sort();
}

/** The environment variables a plugin's own code read while it loaded and ran. */
function checkEnvReads(
  plugin: string,
  record: StandInRecord,
  add: (finding: LintFinding) => void,
): void {
  for (const [action, read] of record.envReads) {
    const keys = [...read].filter((key) => !OS_LOCATIONS.has(key));
    if (keys.length === 0) continue;
    add({
      plugin,
      rule: "run/env-read",
      level: "error",
      ...(action ? { actions: [action] } : {}),
      message: keys.includes("*")
        ? "Stop reading the whole environment; take configuration from connection fields"
        : `Stop reading ${keys.map((k) => `process.env.${k}`).join(", ")}; take each from a connection field (\`env: "NAME"\` on the field supplies it)`,
    });
  }
}

/** A valid input for a schema, or undefined when none can be made. */
function inputFor(
  schema: PluginDef["actions"][number]["inputSchema"],
): unknown {
  if (!schema) return {};
  if (isTypedInputSchema(schema)) {
    try {
      return Create(schema);
    } catch {
      return undefined;
    }
  }
  const input: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(legacyFields(schema)))
    if (field.required) input[name] = standInValue(field);
  return input;
}

/** A value of a field's type, or its default, for a field the lint fills. */
function standInValue(field: { type?: string; default?: unknown }): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "number":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "codemode-lint";
  }
}

/** The fields a resolved credential names as its secret, or undefined when none resolves. */
function declaredSecretFields(
  plugin: PluginDef,
  config: Record<string, unknown>,
): Set<string> | undefined {
  const selection = selectionOf(plugin, config);
  if (!selection) return undefined;
  const fields = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const field = (value as { field?: unknown }).field;
    if (typeof field === "string") fields.add(field);
    for (const nested of Object.values(value)) collect(nested);
  };
  collect(selection.localSecret);
  return fields;
}

function selectionOf(plugin: PluginDef, config: Record<string, unknown>) {
  try {
    return plugin.credential?.(config);
  } catch {
    // A declaration that needs other config to choose its method.
    return undefined;
  }
}

function sourceFiles(dir: string, base = dir): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, base);
    return SOURCE_FILE.test(entry.name) ? [relative(base, path)] : [];
  });
}

interface PackageJson {
  scripts?: Record<string, unknown>;
  codemode?: { lint?: { allow?: Record<string, unknown> } };
}

function readJson(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageOf(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).split("\n")[0] ??
    ""
  );
}
