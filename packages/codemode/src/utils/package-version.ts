import { createRequire } from "node:module";

/**
 * The version in the `package.json` one directory above a module's own, so
 * a packaged plugin states its version once. Pass `import.meta.url`.
 */
export function packageVersion(moduleUrl: string): string {
  return (createRequire(moduleUrl)("../package.json") as { version: string })
    .version;
}
