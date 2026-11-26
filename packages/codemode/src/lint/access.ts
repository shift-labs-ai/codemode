import type { ActionDef } from "../plugin/types.js";

/**
 * What is wrong with an action's `access` label, or undefined when nothing
 * is. Hosts gate actions on `access`, so an action must declare one, and
 * one whose verb changes something is a write whatever it is labelled: a
 * mislabelled mutation is a permission hole. Labelling a read-shaped
 * action `write` is always allowed, the conservative call.
 *
 * `codemode lint` and the bundled plugins' access check
 * (`scripts/lint-plugin-access.ts`) both decide through it, so they hold
 * one rule.
 */
export function accessProblem(
  action: Pick<ActionDef, "name" | "access">,
):
  | { kind: "undeclared" }
  | { kind: "mutating-read"; verb: string }
  | undefined {
  if (action.access !== "read" && action.access !== "write")
    return { kind: "undeclared" };
  const verb = verbOf(action.name);
  if (action.access === "read" && MUTATING_VERBS.has(verb))
    return { kind: "mutating-read", verb };
  return undefined;
}

/** The verbs that change something. */
const MUTATING_VERBS: ReadonlySet<string> = new Set([
  "add",
  "append",
  "approve",
  "archive",
  "assign",
  "cancel",
  "close",
  "copy",
  "create",
  "delete",
  "disable",
  "edit",
  "enable",
  "forward",
  "grant",
  "insert",
  "install",
  "invite",
  "leave",
  "mark",
  "merge",
  "move",
  "post",
  "publish",
  "push",
  "reject",
  "remove",
  "rename",
  "reopen",
  "replace",
  "reply",
  "restart",
  "restore",
  "revoke",
  "rotate",
  "send",
  "set",
  "share",
  "start",
  "stop",
  "submit",
  "trash",
  "trigger",
  "unarchive",
  "unassign",
  "uninstall",
  "unpublish",
  "unshare",
  "unsubscribe",
  "untrash",
  "update",
  "upload",
  "upsert",
]);

/**
 * An action name's verb: the leading word of its last segment
 * (`record.createMany` → `create`), so a noun such as `order.get` or
 * `release.list` is not mistaken for one.
 */
function verbOf(actionName: string): string {
  const last = actionName.split(".").at(-1) ?? actionName;
  return (last.split(/(?=[A-Z])/)[0] ?? last).toLowerCase();
}
