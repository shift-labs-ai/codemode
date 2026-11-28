import assert from "node:assert/strict";
import { it } from "node:test";
import googleCalendar from "../../../codemode-plugins/googleCalendar/src/index.js";
import { createPluginAPI } from "../plugin/api.js";

it("Calendar consent includes Meet settings without dropping Calendar access", () => {
  const { api, resolve } = createPluginAPI("googleCalendar");
  googleCalendar(api);
  const plugin = resolve();
  assert.deepEqual(plugin.oauth?.scopes, [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/meetings.space.settings",
  ]);
  assert.equal(plugin.oauth?.grant, "google");
  assert.ok(plugin.actions.some((action) => action.name === "event.create"));
});
