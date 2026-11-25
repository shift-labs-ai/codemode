/**
 * The verbs that change something. An action whose verb is one of them is
 * a write, whatever it is labelled: hosts gate actions on `access`, so a
 * mislabelled mutation is a permission hole.
 *
 * Shared by `codemode lint` and the bundled plugins' access check
 * (`scripts/lint-plugin-access.ts`), so both hold one list.
 */
export const MUTATING_VERBS: ReadonlySet<string> = new Set([
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
export function verbOf(actionName: string): string {
  const last = actionName.split(".").at(-1) ?? actionName;
  return (last.split(/(?=[A-Z])/)[0] ?? last).toLowerCase();
}
