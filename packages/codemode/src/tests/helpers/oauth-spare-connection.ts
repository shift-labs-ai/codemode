// Run under Node by `oauth-callback.test.ts`: one sign-in during which the
// "browser" also holds a spare connection it never uses. The process ends
// on its own only when the callback listener lets go of that connection.
import { connect } from "node:net";
import { OAUTH_CALLBACK_PORT, runOAuth } from "../../core/oauth.js";

const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, init) =>
  String(input).startsWith("https://auth.example/")
    ? Promise.resolve(Response.json({ access_token: "issued" }))
    : nativeFetch(input, init)) as typeof globalThis.fetch;

const tokens = await runOAuth(
  {
    authUrl: "https://auth.example/authorize",
    tokenUrl: "https://auth.example/token",
    scopes: [],
  },
  {
    clientId: "client",
    clientSecret: "secret",
    onAuthUrl() {},
    async openBrowser(url) {
      // Unreferenced here, so only the listener's end can hold the process.
      connect(OAUTH_CALLBACK_PORT, "127.0.0.1").unref();
      const callback = new URL(
        `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/callback`,
      );
      callback.searchParams.set("code", "c");
      callback.searchParams.set(
        "state",
        new URL(url).searchParams.get("state") ?? "",
      );
      await (await nativeFetch(callback)).text();
    },
  },
);
console.log(tokens.accessToken);
