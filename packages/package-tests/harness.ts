/**
 * What the tests of a package published beside codemode share: the package's
 * plugin in a real engine with a scratch directory, and the package as
 * codemode's package manager loads it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  Codemode,
  type CodemodeOptions,
  MemoryPackageStore,
  PackageManager,
  type PluginFunction,
} from "@shiftlabs/codemode";

export interface PluginHarness {
  /** A directory of the running test's own, removed when it ends. */
  readonly tmp: string;
  /** An engine with the plugin and one connection for it, disposed when the test ends. */
  codemode(
    config?: Record<string, unknown>,
    options?: CodemodeOptions,
  ): Codemode;
  /** Call one of the plugin's actions through an engine and answer its result. */
  call<T>(
    action: string,
    input: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<T>;
}

/** Set up `plugin`, which names itself `name`, for each test of the calling file. */
export function pluginHarness(
  plugin: PluginFunction,
  name: string,
): PluginHarness {
  let tmp = "";
  const instances: Codemode[] = [];

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), `codemode-${name}-`)));
  });

  afterEach(() => {
    for (const instance of instances.splice(0)) instance.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  const harness: PluginHarness = {
    get tmp() {
      return tmp;
    },
    codemode(config = {}, options = {}) {
      const created = Codemode.create({
        plugins: [plugin],
        connections: [{ name, plugin: name, config }],
        ...options,
      });
      instances.push(created);
      return created;
    },
    async call<T>(
      action: string,
      input: Record<string, unknown>,
      config: Record<string, unknown> = {},
    ) {
      const { result, error } = await harness
        .codemode(config)
        .execute(`return await ${name}.${action}(${JSON.stringify(input)})`);
      assert.equal(error, undefined);
      return result as T;
    },
  };
  return harness;
}

/**
 * The test that the package in `directory` loads through the package
 * manager as one plugin, with the actions it should have.
 */
export function describePackage(
  directory: string,
  expected: { package: string; plugin: string; actions: number; write: number },
): void {
  describe("the package", () => {
    it(`loads through the package manager as one plugin named ${expected.plugin}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "codemode-package-"));
      try {
        const packages = new PackageManager({
          roots: { user: join(root, "user") },
          store: new MemoryPackageStore({ user: [directory] }),
        });
        // A package needs a codemode after its last release, and the
        // workspace's carries that release's version until the next one:
        // that warning is right.
        const beyondPeer = (problems: Array<{ code: string }>) =>
          problems.filter((problem) => problem.code !== "peer_unsatisfied");
        const report = await packages.inspect(await packages.fetch(directory));
        assert.deepEqual(beyondPeer(report.problems), []);
        assert.equal(report.name, expected.package);
        assert.equal(report.plugins[0].version, report.version);
        assert.deepEqual(
          report.plugins.map(({ name, actions, write }) => [
            name,
            actions,
            write,
          ]),
          [[expected.plugin, expected.actions, expected.write]],
        );
        const { plugins, problems } = await packages.load();
        assert.deepEqual(beyondPeer(problems), []);
        assert.equal(
          plugins[0].sourceInfo?.owner,
          `local:${directory.replace(/\/$/, "")}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
