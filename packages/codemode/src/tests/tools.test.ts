import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { PackageManager } from "../packages/manager.js";
import { MemoryPackageStore } from "../packages/store.js";
import type { PluginFunction } from "../plugin/api.js";
import { Codemode } from "../sdk.js";
import {
  packageTools,
  parseTools,
  type ToolArtifact,
  type ToolDeclaration,
  toolPlatform,
} from "../tools/declaration.js";
import { ToolError, ToolManager } from "../tools/manager.js";
import { commandExists } from "../utils/cli.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "codemode-tools-")));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The programs here are shell scripts. */
const skip = process.platform === "win32";
const here = toolPlatform();
const URL_A = "https://downloads.test/a/tool";
const URL_B = "https://mirror.test/b/tool";

/**
 * A program that greets. `ok` is its check, which passes only without the
 * host's secret in its environment; `fail` is a check that does not pass.
 */
const SCRIPT = Buffer.from(`#!/bin/sh
case "$1" in
  ok) [ -z "$CODEMODE_TEST_SECRET" ] ;;
  fail) echo "needs a newer libc" >&2; exit 1 ;;
  *) echo "hello $1" ;;
esac
`);

let made = 0;
function fresh(name: string): string {
  const path = join(dir, `${name}-${made++}`);
  mkdirSync(path);
  return path;
}

/** The script at `bin/hello` in an archive `tar` or `zip` makes. */
function archive(kind: "tar.gz" | "zip"): Buffer {
  const source = fresh("source");
  mkdirSync(join(source, "bin"));
  writeFileSync(join(source, "bin", "hello"), SCRIPT, { mode: 0o755 });
  const out = join(fresh("archive"), `tool.${kind}`);
  if (kind === "zip")
    execFileSync("zip", ["-q", "-r", out, "bin"], { cwd: source });
  else execFileSync("tar", ["-czf", out, "-C", source, "bin"]);
  return execFileSync("cat", [out]);
}

function artifact(
  bytes: Buffer,
  rest: Pick<ToolArtifact, "path" | "format">,
  urls = [URL_A],
): ToolArtifact {
  return {
    size: bytes.length,
    hash: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
    providers: urls.map((url) => ({ url })),
    ...rest,
  };
}

function declare(
  build: ToolArtifact,
  check?: string[],
  platform = here,
): ToolDeclaration {
  return { ...(check ? { check } : {}), platforms: { [platform]: build } };
}

/** A `fetch` that answers the given bodies, or the given status, by URL. */
function serving(bodies: Record<string, Buffer | number>) {
  const asked: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const body = bodies[url];
    return typeof body === "number" || body === undefined
      ? new Response(null, { status: body ?? 404 })
      : new Response(new Uint8Array(body));
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

function managerFor(bodies: Record<string, Buffer | number>) {
  const store = fresh("store");
  const { fetch, asked } = serving(bodies);
  return { store, asked, manager: new ToolManager({ dir: store, fetch }) };
}

const run = (program: string, arg: string) =>
  execFileSync(program, [arg], { encoding: "utf8" }).trim();

describe("a tools declaration", () => {
  const valid = {
    size: 12,
    hash: "sha256",
    digest: "a".repeat(64),
    format: "tar.gz",
    path: "bin/tool",
    providers: [{ url: "https://example.com/tool.tar.gz" }],
  };
  const block = (entry: unknown) => ({
    tool: { platforms: { "linux-x86_64": entry } },
  });

  it("keeps the fields of a DotSlash entry that codemode reads", () => {
    const tools = parseTools(
      {
        tool: {
          check: ["--version"],
          platforms: {
            "linux-x86_64": {
              ...valid,
              readonly: true,
              providers: [
                { type: "github-release", repo: "a/b", tag: "v1", name: "t" },
                ...valid.providers,
              ],
            },
          },
        },
      },
      "package.json",
    );
    assert.deepEqual(tools, {
      tool: { check: ["--version"], platforms: { "linux-x86_64": valid } },
    });
  });

  it("names the field that is wrong", () => {
    const at = "package.json: codemode.tools.tool.platforms.linux-x86_64";
    for (const [entry, message] of [
      [{ ...valid, hash: "blake3" }, `${at}.hash must be "sha256"`],
      [
        { ...valid, digest: "ABC" },
        `${at}.digest must be a SHA-256 in lowercase hex`,
      ],
      [
        { ...valid, size: -1 },
        `${at}.size must be the artifact's size in bytes`,
      ],
      [
        { ...valid, format: "rar" },
        `${at}.format must be one of gz, tar, tar.gz, tar.bz2, tar.xz, tar.zst, zip`,
      ],
      [
        { ...valid, path: "../tool" },
        `${at}.path must be a relative path inside the artifact`,
      ],
      [
        { ...valid, path: "/usr/bin/tool" },
        `${at}.path must be a relative path inside the artifact`,
      ],
      [
        { ...valid, providers: [{ url: "http://example.com/tool" }] },
        `${at}.providers must hold at least one { "url": "https://…" }`,
      ],
    ] as const)
      assert.throws(() => parseTools(block(entry), "package.json"), {
        message,
      });
    assert.throws(() => parseTools({ tool: { platforms: {} } }, "p.json"), {
      message:
        "p.json: codemode.tools.tool.platforms must name at least one platform",
    });
    assert.throws(() => parseTools({ "-x": {} }, "p.json"), /usable name/);
  });

  it("is read from the package.json above a plugin's module", () => {
    const moduleOf = (manifest: unknown) => {
      const pkg = fresh("package");
      writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
      return pathToFileURL(join(pkg, "src", "index.js")).href;
    };
    assert.deepEqual(
      packageTools(moduleOf({ codemode: { tools: block(valid) } })),
      block(valid),
    );
    assert.deepEqual(packageTools(moduleOf({ name: "no-tools" })), {});
    assert.throws(
      () => packageTools(moduleOf({ codemode: { tools: { tool: {} } } })),
      /package\.json: codemode\.tools\.tool\.platforms must name at least one platform/,
    );
  });

  it("names this host as DotSlash files do", () => {
    assert.equal(toolPlatform("darwin", "arm64"), "macos-aarch64");
    assert.equal(toolPlatform("linux", "x64"), "linux-x86_64");
    assert.equal(toolPlatform("win32", "x64"), "windows-x86_64");
    assert.equal(toolPlatform("freebsd", "riscv64"), "freebsd-riscv64");
  });
});

describe("installing a tool", { skip }, () => {
  it("downloads, verifies and unpacks an archive, once", async () => {
    const bytes = archive("tar.gz");
    const tool = declare(
      artifact(bytes, { format: "tar.gz", path: "bin/hello" }),
    );
    const { manager, asked, store } = managerFor({ [URL_A]: bytes });

    assert.deepEqual(manager.status(tool), {
      platform: here,
      supported: true,
      hosts: ["downloads.test"],
      size: bytes.length,
      installed: false,
    });
    const program = await manager.install("hello", tool);
    assert.equal(run(program, "there"), "hello there");
    assert.equal(manager.status(tool).path, program);
    assert.equal(await manager.install("hello", tool), program);
    assert.deepEqual(asked, [URL_A]);
    // Nothing is left beside the tool's own folder.
    assert.equal(readdirSync(store).length, 1);
  });

  it("installs a single file, plain or gzipped, under its declared name", async () => {
    const gz = gzipSync(SCRIPT);
    const { manager } = managerFor({ [URL_A]: SCRIPT, [URL_B]: gz });
    const plain = await manager.install(
      "plain",
      declare(artifact(SCRIPT, { path: "greet" })),
    );
    const packed = await manager.install(
      "packed",
      declare(artifact(gz, { format: "gz", path: "greet" }, [URL_B])),
    );
    assert.notEqual(plain, packed);
    assert.equal(run(plain, "a"), "hello a");
    assert.equal(run(packed, "b"), "hello b");
  });

  it("unpacks a zip", {
    skip: !commandExists("zip") || !commandExists("unzip"),
  }, async () => {
    const bytes = archive("zip");
    const { manager } = managerFor({ [URL_A]: bytes });
    const program = await manager.install(
      "hello",
      declare(artifact(bytes, { format: "zip", path: "bin/hello" })),
    );
    assert.equal(run(program, "zip"), "hello zip");
  });

  it("refuses bytes that are not the declared ones, and leaves nothing", async () => {
    const bytes = archive("tar.gz");
    const good = artifact(bytes, { format: "tar.gz", path: "bin/hello" });
    for (const [build, reason] of [
      [
        { ...good, digest: "0".repeat(64) },
        "downloads.test: does not match the declared SHA-256",
      ],
      [
        { ...good, size: bytes.length + 1 },
        `downloads.test: is ${bytes.length} bytes, not the ${bytes.length + 1} declared`,
      ],
      [
        { ...good, size: 10 },
        "downloads.test: is larger than the 10 bytes declared",
      ],
    ] as const) {
      const { manager, store } = managerFor({ [URL_A]: bytes });
      const tool = declare(build);
      await assert.rejects(() => manager.install("hello", tool), {
        code: "download_failed",
        message: `Could not download hello. ${reason}`,
      });
      assert.equal(manager.status(tool).installed, false);
      assert.deepEqual(readdirSync(store), []);
    }
  });

  it("takes the first source that answers the declared bytes", async () => {
    const bytes = archive("tar.gz");
    const tool = declare(
      artifact(bytes, { format: "tar.gz", path: "bin/hello" }, [URL_A, URL_B]),
    );
    const { manager, asked } = managerFor({ [URL_A]: 503, [URL_B]: bytes });
    assert.equal(run(await manager.install("hello", tool), "b"), "hello b");
    assert.deepEqual(asked, [URL_A, URL_B]);

    const none = managerFor({ [URL_A]: 503 });
    await assert.rejects(() => none.manager.install("hello", tool), {
      message:
        "Could not download hello. downloads.test: HTTP 503; mirror.test: HTTP 404",
    });
  });

  it("refuses an archive without the declared program", async () => {
    const bytes = archive("tar.gz");
    const { manager, store } = managerFor({ [URL_A]: bytes });
    await assert.rejects(
      () =>
        manager.install(
          "hello",
          declare(artifact(bytes, { format: "tar.gz", path: "bin/other" })),
        ),
      {
        code: "unpack_failed",
        message:
          "hello: there is no program at bin/other in what was downloaded",
      },
    );
    assert.deepEqual(readdirSync(store), []);
  });

  it("installs only a program whose own check passes, run without the host's environment", async () => {
    const bytes = archive("tar.gz");
    const build = artifact(bytes, { format: "tar.gz", path: "bin/hello" });
    process.env.CODEMODE_TEST_SECRET = "held by the host";
    try {
      const passing = managerFor({ [URL_A]: bytes });
      await passing.manager.install("hello", declare(build, ["ok"]));

      const failing = managerFor({ [URL_A]: bytes });
      const tool = declare(build, ["fail"]);
      await assert.rejects(() => failing.manager.install("hello", tool), {
        code: "check_failed",
        message:
          "hello was not installed: it does not run on this host. needs a newer libc",
      });
      assert.equal(failing.manager.status(tool).installed, false);
      assert.deepEqual(readdirSync(failing.store), []);
    } finally {
      delete process.env.CODEMODE_TEST_SECRET;
    }
  });

  it("downloads nothing offline, and nothing for another platform", async () => {
    const bytes = archive("tar.gz");
    const build = artifact(bytes, { format: "tar.gz", path: "bin/hello" });
    const { fetch, asked } = serving({ [URL_A]: bytes });
    const offline = new ToolManager({
      dir: fresh("store"),
      fetch,
      offline: true,
    });
    await assert.rejects(() => offline.install("hello", declare(build)), {
      code: "offline",
    });

    const online = new ToolManager({ dir: fresh("store"), fetch });
    const elsewhere = declare(build, undefined, "plan9-mips");
    assert.deepEqual(online.status(elsewhere), {
      platform: here,
      supported: false,
      hosts: [],
      installed: false,
    });
    await assert.rejects(() => online.install("hello", elsewhere), {
      code: "unsupported_platform",
      message: `hello has no build for this platform (${here})`,
    });
    assert.deepEqual(asked, []);
  });

  it("removes an installed tool", async () => {
    const bytes = archive("tar.gz");
    const tool = declare(
      artifact(bytes, { format: "tar.gz", path: "bin/hello" }),
    );
    const { manager, store } = managerFor({ [URL_A]: bytes });
    assert.equal(await manager.remove(tool), false);
    await manager.install("hello", tool);
    assert.equal(await manager.remove(tool), true);
    assert.equal(manager.status(tool).installed, false);
    assert.deepEqual(readdirSync(store), []);
  });

  it("describes the artifact at a URL for a declaration's author", async () => {
    const bytes = archive("tar.gz");
    const url = "https://downloads.test/v1/tool_linux_amd64.tar.gz";
    const { fetch } = serving({ [url]: bytes });
    const manager = new ToolManager({ dir: fresh("store"), fetch });
    assert.deepEqual(await manager.describe(url), {
      ...artifact(bytes, { format: "tar.gz", path: "" }, [url]),
    });
    await assert.rejects(() => manager.describe("http://downloads.test/x"), {
      code: "download_failed",
    });
  });
});

describe("a plugin's tools", { skip }, () => {
  const bytes = archive("tar.gz");
  const hello = declare(
    artifact(bytes, { format: "tar.gz", path: "bin/hello" }),
  );
  const demo: PluginFunction = (rl) => {
    rl.setName("demo");
    rl.setTools({ hello });
    rl.registerAction("where", {
      execute: (_input, ctx) => ctx.tool?.("hello"),
    });
    rl.registerAction("other", {
      execute: (_input, ctx) => ctx.tool?.("undeclared"),
    });
  };

  it("reach an action only once the host has installed them", async () => {
    const { manager, asked } = managerFor({ [URL_A]: bytes });
    const codemode = Codemode.create({ plugins: [demo], tools: manager });
    try {
      const before = await codemode.execute("return await demo.where()");
      assert.match(
        before.error ?? "",
        /demo: the program "hello" is not installed\. Run: codemode tools install hello/,
      );
      // An action asking for a tool never fetches it.
      assert.deepEqual(asked, []);
      assert.deepEqual(
        codemode.tools.list().map(({ plugin, name, installed }) => ({
          plugin,
          name,
          installed,
        })),
        [{ plugin: "demo", name: "hello", installed: false }],
      );

      const [installed] = await codemode.tools.install();
      assert.equal(installed.installed, true);
      const afterwards = await codemode.execute("return await demo.where()");
      assert.equal(afterwards.result, installed.path);

      const other = await codemode.execute("return await demo.other()");
      assert.match(
        other.error ?? "",
        /demo declares no tool named "undeclared"/,
      );

      await codemode.tools.remove("hello");
      assert.equal(codemode.tools.list()[0].installed, false);
      await assert.rejects(
        () => codemode.tools.install("nope"),
        (error) =>
          error instanceof ToolError &&
          error.code === "not_declared" &&
          error.message === 'No loaded plugin declares a tool named "nope"',
      );
    } finally {
      codemode.dispose();
    }
  });

  it("are listed by a package's report before it is installed", async () => {
    const pkg = fresh("package");
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "demo-package", version: "1.0.0" }),
    );
    writeFileSync(join(pkg, "index.js"), "export default {};");
    const packages = new PackageManager({
      roots: { user: fresh("user") },
      store: new MemoryPackageStore(),
      loadPlugin: async () => ({
        name: "demo",
        version: "1.0.0",
        actions: [{ name: "where", execute: () => null }],
        tools: { hello },
      }),
    });
    const report = await packages.inspect(pkg);
    assert.deepEqual(report.plugins[0].tools, [
      {
        name: "hello",
        platform: here,
        supported: true,
        hosts: ["downloads.test"],
        size: bytes.length,
      },
    ]);
  });
});
