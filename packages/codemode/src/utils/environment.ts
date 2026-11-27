/**
 * What a program codemode starts inherits from the host's environment when
 * nothing else is named for it: a local MCP server, a program an action
 * runs with `runProgram`, and a binary's own check. Where things are, how
 * text is written, and how the network is reached. Nothing that is a secret
 * by convention.
 */
export const INHERITED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TERM",
  // The way out of a network that has one, and the certificates it is
  // trusted by. Programs read either case.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  // Windows: where programs, profiles and temporary files are found.
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "TEMP",
  "TMP",
];

/** An environment as a process takes one: names with no value left out. */
export function definedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * The host's own values of `INHERITED_ENVIRONMENT`: the whole environment
 * of a program that is given nothing else of the host's.
 */
export function inheritedEnvironment(): Record<string, string> {
  return definedEnvironment(
    Object.fromEntries(
      INHERITED_ENVIRONMENT.map((name) => [name, process.env[name]]),
    ),
  );
}
