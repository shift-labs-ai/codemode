export type McpServerErrorCode =
  /** An entry, a file of entries, or a value in one is malformed. */
  | "invalid_config"
  /** No configured server has the name, or no place is configured for the scope. */
  | "not_found"
  /** The server's name is taken: by another server, or by a plugin it may not replace. */
  | "name_conflict"
  /** A project's server was refused by the trust policy. */
  | "untrusted"
  /** This runtime cannot load the MCP client. */
  | "unsupported_runtime"
  /** The server could not be started or reached, or closed during setup. */
  | "connect_failed"
  /** The server refused the stored credential, or has none: sign in. */
  | "reconnect_required"
  /** The server does not authenticate in a way codemode can sign in to. */
  | "sign_in_unsupported"
  /** A tool reported its own failure (`isError`). */
  | "tool_failed"
  /** The server did not answer a request within its timeout. */
  | "timed_out"
  /** The connection ended while a call waited on it: the server dropped it, or the session was shut down. */
  | "closed";

/**
 * Every failure the MCP manager raises itself. Hosts branch on `code`;
 * `message` is for people and may name the server, never a secret. An
 * error the server answers a request with, and an HTTP status it refuses
 * one with, are thrown as the client raised them.
 */
export class McpServerError extends Error {
  readonly code: McpServerErrorCode;
  readonly server?: string;

  constructor(
    code: McpServerErrorCode,
    message: string,
    options: { server?: string; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "McpServerError";
    this.code = code;
    this.server = options.server;
  }
}

/**
 * By name and code, not `instanceof`: a host and the plugins it loads can
 * hold different copies of codemode's module (its `dist` and its `src`).
 */
export function isMcpServerError(error: unknown): error is McpServerError {
  return (
    error instanceof Error &&
    error.name === "McpServerError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
