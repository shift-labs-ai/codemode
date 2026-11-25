import { createRequire } from "node:module";

/**
 * The `package.json` one directory above a module's own, and where it is:
 * what a packaged plugin states once, there, is read from it. Pass
 * `import.meta.url`.
 */
export function ownPackageJson(moduleUrl: string): {
  path: string;
  manifest: Record<string, unknown>;
} {
  const require = createRequire(moduleUrl);
  const path = require.resolve("../package.json");
  return { path, manifest: require(path) };
}

/** A packaged plugin's version, as its `package.json` states it. */
export function packageVersion(moduleUrl: string): string {
  return ownPackageJson(moduleUrl).manifest.version as string;
}
