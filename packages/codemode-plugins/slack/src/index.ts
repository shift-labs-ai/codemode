import { basename } from "node:path";
import {
  type ActionContext,
  answerFailed,
  type CodemodePluginAPI,
  credentialJson,
  credentialOk,
  type HttpMethod,
  pathWithin,
} from "@shiftlabs/codemode";
import { standardBase64 } from "../../_shared/base64.js";
import { readLocalFile } from "../../_shared/localFile.js";
import { slackCredential } from "./credentials.js";

async function api(
  ctx: ActionContext,
  method: HttpMethod,
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, unknown>,
): Promise<unknown> {
  const data = (await credentialJson(ctx, slackCredential, "slack", {
    target: "api",
    path,
    method,
    query,
    ...(body && Object.keys(body).length > 0 ? { json: body } : {}),
  })) as Record<string, unknown>;
  if (data.ok === false) throw answerFailed("slack", { code: data.error });
  return data;
}

/**
 * A Web API call with a form body. The upload methods
 * (`files.getUploadURLExternal`, `files.completeUploadExternal`) read
 * their arguments from a form or the query, not from JSON.
 */
async function apiForm(
  ctx: ActionContext,
  path: string,
  form: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = (await credentialJson(ctx, slackCredential, "slack", {
    target: "api",
    path,
    method: "POST",
    form,
  })) as Record<string, unknown>;
  if (data.ok === false) throw answerFailed("slack", { code: data.error });
  return data;
}

/**
 * The most one upload carries. Slack accepts up to 1 GB, but the bytes
 * are sent in one buffered request, which the credential transport
 * bounds at 64 MiB.
 */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const OVERSIZE = "slack: file.upload content exceeds the 64 MiB upload limit";

/** A user ID (`U…`, `W…`), which a file is shared to through its DM. */
const USER_ID = /^[UW][A-Z0-9]+$/;

/** The bytes and the name of whichever content source the caller gave. */
async function uploadContent(
  p: Record<string, unknown>,
): Promise<{ bytes: Buffer; name?: string }> {
  const given = ["contentBase64", "contentPath", "content"].filter(
    (key) => p[key] !== undefined,
  );
  if (given.length !== 1)
    throw new Error(
      "slack: file.upload takes exactly one of contentBase64, contentPath or content",
    );
  let file: { bytes: Buffer; name?: string };
  if (p.contentBase64 !== undefined) {
    const base64 =
      typeof p.contentBase64 === "string"
        ? standardBase64(p.contentBase64)
        : undefined;
    if (base64 === undefined)
      throw new Error("slack: file.upload contentBase64 is not valid base64");
    file = { bytes: Buffer.from(base64, "base64") };
  } else if (p.contentPath !== undefined) {
    const path = String(p.contentPath);
    file = {
      bytes: await readLocalFile(path, {
        subject: "slack: file.upload contentPath",
        maxBytes: MAX_UPLOAD_BYTES,
        oversize: OVERSIZE,
      }),
      name: basename(path),
    };
  } else {
    file = { bytes: Buffer.from(String(p.content), "utf8") };
  }
  if (file.bytes.length === 0)
    throw new Error("slack: file.upload content is empty");
  if (file.bytes.length > MAX_UPLOAD_BYTES) throw new Error(OVERSIZE);
  return file;
}

export default function slack(rl: CodemodePluginAPI) {
  rl.setName("slack");
  rl.setVersion("0.1.0");
  rl.setCredential(slackCredential);
  rl.setConnectionSchema({
    accessToken: {
      type: "string",
      required: true,
      description: "Slack Bot/User token",
      env: "SLACK_ACCESS_TOKEN",
    },
  });
  // ── Message ─────────────────────────────────────────

  rl.registerAction("message.post", {
    access: "write",
    description: "Post a message to a channel or user",
    inputSchema: {
      channel: { type: "string", required: true },
      text: { type: "string", required: false },
      blocks: { type: "object", required: false },
      threadTs: { type: "string", required: false },
      replyBroadcast: { type: "boolean", required: false },
      unfurlLinks: { type: "boolean", required: false },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      const body: Record<string, unknown> = { channel: p.channel };
      if (p.text) body.text = p.text;
      if (p.blocks) body.blocks = p.blocks;
      if (p.threadTs) body.thread_ts = p.threadTs;
      if (p.replyBroadcast) body.reply_broadcast = true;
      if (p.unfurlLinks !== undefined) body.unfurl_links = p.unfurlLinks;
      return api(ctx, "POST", "chat.postMessage", body);
    },
  });

  rl.registerAction("message.update", {
    access: "write",
    description: "Update a message",
    inputSchema: {
      channel: { type: "string", required: true },
      ts: { type: "string", required: true },
      text: { type: "string", required: false },
      blocks: { type: "object", required: false },
    },
    async execute(input, ctx) {
      return api(ctx, "POST", "chat.update", input as Record<string, unknown>);
    },
  });

  rl.registerAction("message.delete", {
    access: "write",
    description: "Delete a message",
    inputSchema: {
      channel: { type: "string", required: true },
      ts: { type: "string", required: true },
    },
    async execute(input, ctx) {
      return api(ctx, "POST", "chat.delete", input as Record<string, unknown>);
    },
  });

  rl.registerAction("message.getPermalink", {
    access: "read",
    description: "Get a message permalink",
    inputSchema: {
      channel: { type: "string", required: true },
      messageTs: { type: "string", required: true },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      return api(ctx, "GET", "chat.getPermalink", undefined, {
        channel: p.channel,
        message_ts: p.messageTs,
      });
    },
  });

  rl.registerAction("message.search", {
    access: "read",
    description: "Search messages",
    inputSchema: {
      query: { type: "string", required: true },
      sort: {
        type: "string",
        required: false,
        description: "score or timestamp",
      },
      limit: { type: "number", required: false },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      const qs: Record<string, unknown> = { query: p.query };
      if (p.sort) qs.sort = p.sort === "relevance" ? "score" : "timestamp";
      if (p.limit) qs.count = p.limit;
      const data = (await api(
        ctx,
        "POST",
        "search.messages",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return (data.messages as Record<string, unknown>)?.matches;
    },
  });

  // ── Channel ─────────────────────────────────────────

  rl.registerAction("channel.create", {
    access: "write",
    description: "Create a channel",
    inputSchema: {
      name: { type: "string", required: true },
      isPrivate: { type: "boolean", required: false },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      const data = (await api(ctx, "POST", "conversations.create", {
        name: p.name,
        is_private: p.isPrivate ?? false,
      })) as Record<string, unknown>;
      return data.channel;
    },
  });

  rl.registerAction("channel.get", {
    access: "read",
    description: "Get channel info",
    inputSchema: { channel: { type: "string", required: true } },
    async execute(input, ctx) {
      const data = (await api(ctx, "POST", "conversations.info", undefined, {
        channel: (input as Record<string, unknown>).channel,
      })) as Record<string, unknown>;
      return data.channel;
    },
  });

  rl.registerAction("channel.list", {
    access: "read",
    description: "List channels",
    inputSchema: {
      limit: { type: "number", required: false },
      types: {
        type: "string",
        required: false,
        description: "Comma-separated: public_channel,private_channel",
      },
      excludeArchived: { type: "boolean", required: false },
    },
    async execute(input, ctx) {
      const p = (input ?? {}) as Record<string, unknown>;
      const qs: Record<string, unknown> = {
        types: p.types ?? "public_channel,private_channel",
      };
      if (p.limit) qs.limit = p.limit;
      if (p.excludeArchived) qs.exclude_archived = true;
      const data = (await api(
        ctx,
        "GET",
        "conversations.list",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return data.channels;
    },
  });

  rl.registerAction("channel.history", {
    access: "read",
    description: "Get channel message history",
    inputSchema: {
      channel: { type: "string", required: true },
      limit: { type: "number", required: false },
      oldest: { type: "string", required: false, description: "ISO datetime" },
      latest: { type: "string", required: false },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      const qs: Record<string, unknown> = { channel: p.channel };
      if (p.limit) qs.limit = p.limit;
      if (p.oldest) qs.oldest = new Date(p.oldest as string).getTime() / 1000;
      if (p.latest) qs.latest = new Date(p.latest as string).getTime() / 1000;
      const data = (await api(
        ctx,
        "GET",
        "conversations.history",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return data.messages;
    },
  });

  rl.registerAction("channel.replies", {
    access: "read",
    description: "Get thread replies",
    inputSchema: {
      channel: { type: "string", required: true },
      ts: { type: "string", required: true },
      limit: { type: "number", required: false },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      const qs: Record<string, unknown> = { channel: p.channel, ts: p.ts };
      if (p.limit) qs.limit = p.limit;
      const data = (await api(
        ctx,
        "GET",
        "conversations.replies",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return data.messages;
    },
  });

  rl.registerAction("channel.invite", {
    access: "write",
    description: "Invite users to a channel",
    inputSchema: {
      channel: { type: "string", required: true },
      users: {
        type: "string",
        required: true,
        description: "Comma-separated user IDs",
      },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      const data = (await api(ctx, "POST", "conversations.invite", {
        channel: p.channel,
        users: p.users,
      })) as Record<string, unknown>;
      return data.channel;
    },
  });

  rl.registerAction("channel.kick", {
    access: "write",
    description: "Remove a user from a channel",
    inputSchema: {
      channel: { type: "string", required: true },
      user: { type: "string", required: true },
    },
    async execute(input, ctx) {
      return api(
        ctx,
        "POST",
        "conversations.kick",
        input as Record<string, unknown>,
      );
    },
  });

  rl.registerAction("channel.join", {
    access: "write",
    description: "Join a channel",
    inputSchema: { channel: { type: "string", required: true } },
    async execute(input, ctx) {
      const data = (await api(ctx, "POST", "conversations.join", {
        channel: (input as Record<string, unknown>).channel,
      })) as Record<string, unknown>;
      return data.channel;
    },
  });

  rl.registerAction("channel.leave", {
    access: "write",
    description: "Leave a channel",
    inputSchema: { channel: { type: "string", required: true } },
    async execute(input, ctx) {
      return api(ctx, "POST", "conversations.leave", {
        channel: (input as Record<string, unknown>).channel,
      });
    },
  });

  rl.registerAction("channel.archive", {
    access: "write",
    description: "Archive a channel",
    inputSchema: { channel: { type: "string", required: true } },
    async execute(input, ctx) {
      return api(ctx, "POST", "conversations.archive", {
        channel: (input as Record<string, unknown>).channel,
      });
    },
  });

  rl.registerAction("channel.unarchive", {
    access: "write",
    description: "Unarchive a channel",
    inputSchema: { channel: { type: "string", required: true } },
    async execute(input, ctx) {
      return api(ctx, "POST", "conversations.unarchive", {
        channel: (input as Record<string, unknown>).channel,
      });
    },
  });

  rl.registerAction("channel.rename", {
    access: "write",
    description: "Rename a channel",
    inputSchema: {
      channel: { type: "string", required: true },
      name: { type: "string", required: true },
    },
    async execute(input, ctx) {
      const data = (await api(
        ctx,
        "POST",
        "conversations.rename",
        input as Record<string, unknown>,
      )) as Record<string, unknown>;
      return data.channel;
    },
  });

  rl.registerAction("channel.setTopic", {
    access: "write",
    description: "Set channel topic",
    inputSchema: {
      channel: { type: "string", required: true },
      topic: { type: "string", required: true },
    },
    async execute(input, ctx) {
      const data = (await api(
        ctx,
        "POST",
        "conversations.setTopic",
        input as Record<string, unknown>,
      )) as Record<string, unknown>;
      return data.channel;
    },
  });

  rl.registerAction("channel.setPurpose", {
    access: "write",
    description: "Set channel purpose",
    inputSchema: {
      channel: { type: "string", required: true },
      purpose: { type: "string", required: true },
    },
    async execute(input, ctx) {
      const data = (await api(
        ctx,
        "POST",
        "conversations.setPurpose",
        input as Record<string, unknown>,
      )) as Record<string, unknown>;
      return data.channel;
    },
  });

  rl.registerAction("channel.members", {
    access: "read",
    description: "List channel members",
    inputSchema: {
      channel: { type: "string", required: true },
      limit: { type: "number", required: false },
    },
    async execute(input, ctx) {
      const p = input as Record<string, unknown>;
      const qs: Record<string, unknown> = { channel: p.channel };
      if (p.limit) qs.limit = p.limit;
      const data = (await api(
        ctx,
        "GET",
        "conversations.members",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return (data.members as string[]).map((m) => ({ member: m }));
    },
  });

  // ── Reaction ────────────────────────────────────────

  rl.registerAction("reaction.add", {
    access: "write",
    description: "Add a reaction to a message",
    inputSchema: {
      channel: { type: "string", required: true },
      timestamp: { type: "string", required: true },
      name: {
        type: "string",
        required: true,
        description: "Emoji name without colons",
      },
    },
    async execute(input, ctx) {
      return api(
        ctx,
        "POST",
        "reactions.add",
        input as Record<string, unknown>,
      );
    },
  });

  rl.registerAction("reaction.remove", {
    access: "write",
    description: "Remove a reaction",
    inputSchema: {
      channel: { type: "string", required: true },
      timestamp: { type: "string", required: true },
      name: { type: "string", required: true },
    },
    async execute(input, ctx) {
      return api(
        ctx,
        "POST",
        "reactions.remove",
        input as Record<string, unknown>,
      );
    },
  });

  rl.registerAction("reaction.get", {
    access: "read",
    description: "Get reactions for a message",
    inputSchema: {
      channel: { type: "string", required: true },
      timestamp: { type: "string", required: true },
    },
    async execute(input, ctx) {
      return api(
        ctx,
        "GET",
        "reactions.get",
        undefined,
        input as Record<string, unknown>,
      );
    },
  });

  // ── User ────────────────────────────────────────────

  rl.registerAction("user.info", {
    access: "read",
    description: "Get user info",
    inputSchema: { user: { type: "string", required: true } },
    async execute(input, ctx) {
      const data = (await api(ctx, "GET", "users.info", undefined, {
        user: (input as Record<string, unknown>).user,
      })) as Record<string, unknown>;
      return data.user;
    },
  });

  rl.registerAction("user.list", {
    access: "read",
    description: "List all users",
    inputSchema: { limit: { type: "number", required: false } },
    async execute(input, ctx) {
      const qs: Record<string, unknown> = {};
      if ((input as Record<string, unknown>)?.limit)
        qs.limit = (input as Record<string, unknown>).limit;
      const data = (await api(
        ctx,
        "GET",
        "users.list",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return data.members;
    },
  });

  rl.registerAction("user.getPresence", {
    access: "read",
    description: "Get a user's presence",
    inputSchema: { user: { type: "string", required: true } },
    async execute(input, ctx) {
      return api(ctx, "GET", "users.getPresence", undefined, {
        user: (input as Record<string, unknown>).user,
      });
    },
  });

  rl.registerAction("user.getProfile", {
    access: "read",
    description: "Get a user's profile",
    inputSchema: { user: { type: "string", required: true } },
    async execute(input, ctx) {
      const data = (await api(ctx, "GET", "users.profile.get", undefined, {
        user: (input as Record<string, unknown>).user,
      })) as Record<string, unknown>;
      return data.profile;
    },
  });

  rl.registerAction("user.updateProfile", {
    access: "write",
    description: "Update the authenticated user's profile",
    inputSchema: {
      profile: {
        type: "object",
        required: true,
        description: "Profile fields to set",
      },
    },
    async execute(input, ctx) {
      const data = (await api(ctx, "POST", "users.profile.set", {
        profile: (input as Record<string, unknown>).profile,
      })) as Record<string, unknown>;
      return data.profile;
    },
  });

  // ── User Group ──────────────────────────────────────

  rl.registerAction("userGroup.create", {
    access: "write",
    description: "Create a user group",
    inputSchema: {
      name: { type: "string", required: true },
      handle: { type: "string", required: false },
      description: { type: "string", required: false },
    },
    async execute(input, ctx) {
      const data = (await api(
        ctx,
        "POST",
        "usergroups.create",
        input as Record<string, unknown>,
      )) as Record<string, unknown>;
      return data.usergroup;
    },
  });

  rl.registerAction("userGroup.list", {
    access: "read",
    description: "List user groups",
    inputSchema: { includeUsers: { type: "boolean", required: false } },
    async execute(input, ctx) {
      const qs: Record<string, unknown> = {};
      if ((input as Record<string, unknown>)?.includeUsers)
        qs.include_users = true;
      const data = (await api(
        ctx,
        "GET",
        "usergroups.list",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return data.usergroups;
    },
  });

  rl.registerAction("userGroup.update", {
    access: "write",
    description: "Update a user group",
    inputSchema: {
      usergroup: { type: "string", required: true },
      name: { type: "string", required: false },
      handle: { type: "string", required: false },
      description: { type: "string", required: false },
    },
    async execute(input, ctx) {
      const data = (await api(
        ctx,
        "POST",
        "usergroups.update",
        input as Record<string, unknown>,
      )) as Record<string, unknown>;
      return data.usergroup;
    },
  });

  rl.registerAction("userGroup.enable", {
    access: "write",
    description: "Enable a user group",
    inputSchema: { usergroup: { type: "string", required: true } },
    async execute(input, ctx) {
      const data = (await api(ctx, "POST", "usergroups.enable", {
        usergroup: (input as Record<string, unknown>).usergroup,
      })) as Record<string, unknown>;
      return data.usergroup;
    },
  });

  rl.registerAction("userGroup.disable", {
    access: "write",
    description: "Disable a user group",
    inputSchema: { usergroup: { type: "string", required: true } },
    async execute(input, ctx) {
      const data = (await api(ctx, "POST", "usergroups.disable", {
        usergroup: (input as Record<string, unknown>).usergroup,
      })) as Record<string, unknown>;
      return data.usergroup;
    },
  });

  // ── File ────────────────────────────────────────────

  rl.registerAction("file.upload", {
    access: "write",
    description:
      "Upload a file and optionally share it to a channel, a DM or a thread. Give exactly one of contentBase64, contentPath (a file on the codemode host) or content (UTF-8 text). `channel` takes a conversation ID, or a user ID to share in a DM with that user (needs the im:write scope). Without `channel` the file stays private to the uploader. Up to 64 MiB. Returns the uploaded files ({ id, title }).",
    inputSchema: {
      channel: {
        type: "string",
        required: false,
        description:
          "Conversation ID (C…, G…, D…) or user ID (U…, W…) to share in a DM",
      },
      filename: {
        type: "string",
        required: false,
        description:
          "File name, with extension; defaults to contentPath's name, else 'file'",
      },
      title: { type: "string", required: false },
      contentBase64: { type: "string", required: false },
      contentPath: { type: "string", required: false },
      content: { type: "string", required: false },
      initialComment: {
        type: "string",
        required: false,
        description: "Message text posted with the file",
      },
      threadTs: {
        type: "string",
        required: false,
        description: "Share as a reply in this thread (needs channel)",
      },
      altText: {
        type: "string",
        required: false,
        description: "Description of an image, for screen readers",
      },
      snippetType: {
        type: "string",
        required: false,
        description: "Syntax type of a snippet, e.g. python or javascript",
      },
    },
    async execute(input, ctx) {
      const p = (input ?? {}) as Record<string, unknown>;
      if (p.threadTs !== undefined && p.channel === undefined)
        throw new Error("slack: file.upload threadTs needs a channel");
      const file = await uploadContent(p);
      const filename = String(p.filename ?? file.name ?? "file");

      let channel = p.channel === undefined ? undefined : String(p.channel);
      if (channel !== undefined && USER_ID.test(channel)) {
        const opened = (await api(ctx, "POST", "conversations.open", {
          users: channel,
        })) as { channel?: { id?: unknown } };
        if (typeof opened.channel?.id !== "string")
          throw new Error("slack: conversations.open returned no channel");
        channel = opened.channel.id;
      }

      const ticket = await apiForm(ctx, "files.getUploadURLExternal", {
        filename,
        length: file.bytes.length,
        alt_text: p.altText,
        snippet_type: p.snippetType,
      });
      if (
        typeof ticket.upload_url !== "string" ||
        typeof ticket.file_id !== "string"
      )
        throw new Error("slack: files.getUploadURLExternal returned no upload");

      await credentialOk(ctx, slackCredential, "slack", {
        target: "upload",
        path: pathWithin(ctx, slackCredential, "upload", ticket.upload_url),
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(file.bytes),
      });

      const done = await apiForm(ctx, "files.completeUploadExternal", {
        files: JSON.stringify([
          { id: ticket.file_id, title: p.title ?? filename },
        ]),
        channel_id: channel,
        initial_comment: p.initialComment,
        thread_ts: p.threadTs,
      });
      return done.files;
    },
  });

  rl.registerAction("file.get", {
    access: "read",
    description: "Get file info",
    inputSchema: { file: { type: "string", required: true } },
    async execute(input, ctx) {
      const data = (await api(ctx, "GET", "files.info", undefined, {
        file: (input as Record<string, unknown>).file,
      })) as Record<string, unknown>;
      return data.file;
    },
  });

  rl.registerAction("file.list", {
    access: "read",
    description: "List files",
    inputSchema: {
      channel: { type: "string", required: false },
      limit: { type: "number", required: false },
      types: { type: "string", required: false },
    },
    async execute(input, ctx) {
      const p = (input ?? {}) as Record<string, unknown>;
      const qs: Record<string, unknown> = {};
      if (p.channel) qs.channel = p.channel;
      if (p.limit) qs.count = p.limit;
      if (p.types) qs.types = p.types;
      const data = (await api(
        ctx,
        "GET",
        "files.list",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return data.files;
    },
  });

  // ── Star ────────────────────────────────────────────

  rl.registerAction("star.add", {
    access: "write",
    description: "Star an item",
    inputSchema: {
      channel: { type: "string", required: false },
      timestamp: { type: "string", required: false },
      file: { type: "string", required: false },
    },
    async execute(input, ctx) {
      return api(ctx, "POST", "stars.add", input as Record<string, unknown>);
    },
  });

  rl.registerAction("star.remove", {
    access: "write",
    description: "Unstar an item",
    inputSchema: {
      channel: { type: "string", required: false },
      timestamp: { type: "string", required: false },
      file: { type: "string", required: false },
    },
    async execute(input, ctx) {
      return api(ctx, "POST", "stars.remove", input as Record<string, unknown>);
    },
  });

  rl.registerAction("star.list", {
    access: "read",
    description: "List starred items",
    inputSchema: { limit: { type: "number", required: false } },
    async execute(input, ctx) {
      const qs: Record<string, unknown> = {};
      if ((input as Record<string, unknown>)?.limit)
        qs.limit = (input as Record<string, unknown>).limit;
      const data = (await api(
        ctx,
        "GET",
        "stars.list",
        undefined,
        qs,
      )) as Record<string, unknown>;
      return data.items;
    },
  });
}
