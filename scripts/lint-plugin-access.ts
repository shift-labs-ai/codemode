#!/usr/bin/env bun
/**
 * Lint every bundled plugin: its name, and the `access` label on each
 * of its actions.
 *
 * A bundled plugin declares the name of its folder. Discovery and the
 * package manager read the bundled names from the folder listing without
 * importing every module, so a plugin named otherwise would be loaded,
 * gated and reserved under the wrong name.
 *
 * Hosts gate actions on `access`: a `read` action may run where writes
 * are refused, so every action declares one and a verb that changes
 * something is `write`. `accessProblem` (`lint/verbs.ts`) decides both,
 * the same rule `codemode lint` applies to every other package.
 *
 * It loads the plugins rather than parsing them, so actions registered
 * through helpers and loops are checked as the host sees them.
 *
 *   bun scripts/lint-plugin-access.ts
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { accessProblem } from "../packages/codemode/src/lint/verbs.ts";
import { loadPluginFromPath } from "../packages/codemode/src/plugin/loader.ts";

const PLUGINS_DIR = join(import.meta.dir, "../packages/codemode-plugins");

const problems: string[] = [];
let actions = 0;
const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name))
  .filter((d) => existsSync(join(PLUGINS_DIR, d.name, "src", "index.ts")))
  .map((d) => d.name)
  .sort();

for (const dir of dirs) {
  let plugin: Awaited<ReturnType<typeof loadPluginFromPath>>;
  try {
    plugin = await loadPluginFromPath(join(PLUGINS_DIR, dir));
  } catch (error) {
    problems.push(`${dir}: does not load (${(error as Error).message})`);
    continue;
  }
  if (plugin.name !== dir)
    problems.push(
      `${dir}: declares the name "${plugin.name}", not its folder's`,
    );
  for (const action of plugin.actions) {
    actions++;
    const path = `${plugin.name}.${action.name}`;
    const access = accessProblem(action);
    if (access?.kind === "undeclared")
      problems.push(`${path}: declare access "read" or "write"`);
    else if (access?.kind === "mutating-read")
      problems.push(
        `${path}: "${access.verb}" mutates, so access must be "write"`,
      );
  }
}

if (problems.length > 0) {
  console.error(`plugin access: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`plugin access: ${actions} actions in ${dirs.length} plugins`);
