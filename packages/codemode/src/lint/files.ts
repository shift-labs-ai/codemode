import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { LintFinding } from "./lint.js";

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
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const SOURCE_FILE = /\.(c|m)?(j|t)sx?$/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

export interface PackageJson {
  scripts?: Record<string, unknown>;
  codemode?: { lint?: { allow?: Record<string, unknown> } };
}

/**
 * What a package's files hold, read without running them: the install
 * scripts its package.json declares, and every source line outside
 * `node_modules` and dot folders.
 */
export function checkFiles(
  dir: string,
  pkg: PackageJson | undefined,
  add: (finding: LintFinding) => void,
): void {
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
}

export function readJson(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
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
