import { resolve } from "node:path";
import chalk from "chalk";
import { type LintFinding, lintPackage } from "../lint/lint.js";
import { failCommand, printJson } from "../utils/output.js";

/**
 * `codemode lint [dir]`: check a plugin package, print what is wrong, and
 * exit 1 when anything is an error. `--json` prints the report as it is.
 */
export async function lint(
  dir: string | undefined,
  options: { json?: boolean },
): Promise<void> {
  const root = resolve(dir ?? ".");
  let report: Awaited<ReturnType<typeof lintPackage>>;
  try {
    report = await lintPackage(root);
  } catch (error) {
    failCommand(error, { json: options.json });
  }
  if (options.json) printJson(report);
  else {
    for (const finding of report.findings) console.log(line(finding));
    for (const plugin of report.plugins)
      console.log(
        chalk.dim(
          `${plugin.name} ${plugin.version}: ${plugin.actions} actions (${plugin.read} read, ${plugin.write} write)${plugin.hosts.length ? ` → ${plugin.hosts.join(", ")}` : ""}`,
        ),
      );
    const errors = report.findings.filter((f) => f.level === "error").length;
    const warnings = report.findings.length - errors;
    console.log(
      errors
        ? chalk.red(
            `✖ ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`,
          )
        : chalk.green(
            `✓ no errors${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`,
          ),
    );
  }
  // An action that outlived its timeout may still hold the event loop open.
  process.exit(report.ok ? 0 : 1);
}

function line(finding: LintFinding): string {
  const mark = finding.level === "error" ? chalk.red("✖") : chalk.yellow("▲");
  const where =
    finding.file !== undefined
      ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}`
      : (finding.plugin ?? "");
  const actions = finding.actions?.length
    ? chalk.dim(` (${finding.actions.join(", ")})`)
    : "";
  const allowed = finding.allowed
    ? chalk.dim(` allowed: ${finding.allowed}`)
    : "";
  return `${mark} ${chalk.bold(finding.rule)} ${where ? `${chalk.dim(where)} ` : ""}${finding.message}${actions}${allowed}`;
}
