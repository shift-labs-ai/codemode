import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import slack from "../../../codemode-plugins/slack/src/index.js";
import { createPluginAPI } from "../plugin/api.js";
import type { ActionContext } from "../plugin/types.js";
import { getAction, stubFetch } from "./helpers/plugin.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const UPLOAD_URL = "https://files.slack.com/upload/v1/CwABAAAAXAoAAZnoN2Iv";

function upload() {
  const { api, resolve } = createPluginAPI("slack");
  slack(api);
  return getAction(resolve(), "file.upload");
}

const ctx: ActionContext = {
  connection: {
    name: "slack",
    plugin: "slack",
    config: { accessToken: "xoxb-secret" },
  },
  log: { info() {}, warn() {}, error() {} },
  async updateConnection() {},
};

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  type: string | null;
  body: string;
}

/** Slack's three upload steps, answered in order, every request recorded. */
function stubSlack(seen: Seen[]) {
  stubFetch(async (url, init) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      type: headers.get("content-type"),
      body:
        body === undefined || body === null
          ? ""
          : typeof body === "string"
            ? body
            : Buffer.from(body as Uint8Array).toString("utf8"),
    });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    const path = new URL(String(url)).pathname;
    if (path === "/api/conversations.open")
      return json({ ok: true, channel: { id: "D42" } });
    if (path === "/api/files.getUploadURLExternal")
      return json({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" });
    if (path.startsWith("/upload/v1/"))
      return new Response("OK - 5", {
        headers: { "content-type": "text/plain" },
      });
    if (path === "/api/files.completeUploadExternal")
      return json({ ok: true, files: [{ id: "F1", title: "notes.txt" }] });
    return new Response("unexpected", { status: 404 });
  });
}

describe("slack file.upload", () => {
  it("uploads text in Slack's three steps and shares it to the channel", async () => {
    const seen: Seen[] = [];
    stubSlack(seen);
    const files = await upload().execute(
      {
        channel: "C123",
        filename: "notes.txt",
        content: "hello",
        initialComment: "see attached",
        threadTs: "1700000000.000100",
      },
      ctx,
    );
    assert.deepEqual(files, [{ id: "F1", title: "notes.txt" }]);
    assert.equal(seen.length, 3);

    const [ticket, bytes, done] = seen;
    assert.equal(
      ticket.url,
      "https://slack.com/api/files.getUploadURLExternal",
    );
    assert.equal(ticket.auth, "Bearer xoxb-secret");
    assert.match(ticket.type ?? "", /application\/x-www-form-urlencoded/);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(ticket.body)), {
      filename: "notes.txt",
      length: "5",
    });

    assert.equal(bytes.url, UPLOAD_URL);
    assert.equal(bytes.method, "POST");
    assert.equal(bytes.body, "hello");

    assert.equal(
      done.url,
      "https://slack.com/api/files.completeUploadExternal",
    );
    const form = Object.fromEntries(new URLSearchParams(done.body));
    assert.deepEqual(JSON.parse(form.files), [
      { id: "F1", title: "notes.txt" },
    ]);
    assert.equal(form.channel_id, "C123");
    assert.equal(form.initial_comment, "see attached");
    assert.equal(form.thread_ts, "1700000000.000100");
  });

  it("opens the DM when the channel is a user ID", async () => {
    const seen: Seen[] = [];
    stubSlack(seen);
    await upload().execute(
      {
        channel: "U0ABC",
        contentBase64: Buffer.from("hello").toString("base64"),
      },
      ctx,
    );
    assert.equal(seen[0].url, "https://slack.com/api/conversations.open");
    assert.deepEqual(JSON.parse(seen[0].body), { users: "U0ABC" });
    const form = Object.fromEntries(new URLSearchParams(seen[3].body));
    assert.equal(form.channel_id, "D42");
    assert.deepEqual(JSON.parse(form.files), [{ id: "F1", title: "file" }]);
  });

  it("names a local file for its path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slack-upload-"));
    try {
      const path = join(dir, "report.csv");
      await writeFile(path, "a,b\n1,2\n");
      const seen: Seen[] = [];
      stubSlack(seen);
      await upload().execute({ contentPath: path }, ctx);
      const ticket = Object.fromEntries(new URLSearchParams(seen[0].body));
      assert.deepEqual(ticket, { filename: "report.csv", length: "8" });
      assert.equal(seen[1].body, "a,b\n1,2\n");
      const done = Object.fromEntries(new URLSearchParams(seen[2].body));
      assert.equal(done.channel_id, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an upload URL off Slack's file host before sending the bytes", async () => {
    const seen: string[] = [];
    stubFetch(async (url) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          ok: true,
          upload_url: "https://evil.example.com/upload/v1/x",
          file_id: "F1",
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    await assert.rejects(
      upload().execute({ channel: "C1", content: "hello" }, ctx),
    );
    assert.deepEqual(seen, [
      "https://slack.com/api/files.getUploadURLExternal",
    ]);
  });

  it("refuses ambiguous or missing content before any request", async () => {
    stubFetch(async () => {
      throw new Error("no request expected");
    });
    await assert.rejects(
      upload().execute({ content: "a", contentBase64: "YQ==" }, ctx),
      /exactly one of/,
    );
    await assert.rejects(upload().execute({}, ctx), /exactly one of/);
    await assert.rejects(
      upload().execute({ contentBase64: "not base64!" }, ctx),
      /not valid base64/,
    );
    await assert.rejects(
      upload().execute({ content: "a", threadTs: "1.2" }, ctx),
      /needs a channel/,
    );
  });
});
