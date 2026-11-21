import chalk from "chalk";

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printSuccess(msg: string): void {
  console.log(chalk.green("✓"), msg);
}

export function printError(msg: string): void {
  console.error(chalk.red("✗"), msg);
}

export function printWarn(msg: string): void {
  console.warn(chalk.yellow("⚠"), msg);
}

/**
 * Report a command's failure and exit with status 1. With `json`, one
 * object on stdout: `{ ok: false, error, code }` and whatever `details`
 * adds; `code` is the error's own, for an error that carries one.
 */
export function failCommand(
  err: unknown,
  options: { json?: boolean; code?: string; details?: object } = {},
): never {
  const message = err instanceof Error ? err.message : String(err);
  if (options.json)
    printJson({
      ok: false,
      error: message,
      code: options.code,
      ...options.details,
    });
  else printError(message);
  process.exit(1);
}

/**
 * Repeated `KEY=VALUE` arguments as an object. The value may itself
 * contain `=`; a pair with no key or no `=` is an error naming `flag`.
 */
export function keyValuePairs(
  values: string[],
  flag: string,
): Record<string, string> {
  return Object.fromEntries(
    values.map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0)
        throw new Error(`Invalid ${flag} value: ${pair} (expected key=value)`);
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );
}
