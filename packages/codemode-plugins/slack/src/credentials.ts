import { staticCredential } from "@shiftlabs/codemode";

/**
 * A bot or user token, sent as a bearer to Slack's API, and to the upload
 * URLs `files.getUploadURLExternal` issues on Slack's file host.
 */
export const slackCredential = staticCredential({
  id: "slack",
  auth: { kind: "bearer" },
  local: { secret: "accessToken" },
  targets: {
    api: {
      baseUrl: "https://slack.com/api/",
      methods: ["GET", "POST"],
    },
    upload: {
      baseUrl: "https://files.slack.com/upload/v1/",
      methods: ["POST"],
      timeoutMs: 120_000,
    },
  },
  probe: {
    target: "api",
    path: "auth.test",
    method: "GET",
    acceptedStatuses: [200],
  },
});
