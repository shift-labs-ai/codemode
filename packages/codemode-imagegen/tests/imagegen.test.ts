/**
 * The image generation package: its three actions through a real engine
 * with the providers' hosts stood in for, the pieces that translate a size
 * and read a model's schema, and the package as codemode's package manager
 * loads it.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { PluginFunction } from "@shiftlabs/codemode";
import { stubFetch } from "../../codemode/src/tests/helpers/plugin.js";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import { imageFacts } from "../src/image.js";
import { type ImageProvider, imagegen, PROVIDERS } from "../src/index.js";
import { fieldsOf, inputFor } from "../src/schema.js";
import { fitSize, nearestRatio, nearestSize } from "../src/size.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/** The first bytes of a PNG of this size: all that tells an image's type and size. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const PNG = png(1024, 768);
const B64 = PNG.toString("base64");

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The body as JSON, or as text when it is not JSON. */
  body: unknown;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Answer each request by the first route whose text its URL holds, and
 * collect what was sent. A route answers JSON, or bytes for a download.
 */
function serve(
  routes: Array<[string, (sent: Sent) => unknown]>,
  status = 200,
): Sent[] {
  const all: Sent[] = [];
  stubFetch(async (url, init) => {
    const text = init?.body
      ? Buffer.from(init.body as Uint8Array).toString()
      : "";
    let body: unknown = text || null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    const sent = {
      method: init?.method ?? "GET",
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body,
    };
    all.push(sent);
    const route = routes.find(([part]) => sent.url.includes(part));
    assert.ok(route, `no route for ${sent.method} ${sent.url}`);
    const answer = route[1](sent);
    return Buffer.isBuffer(answer)
      ? new Response(new Uint8Array(answer))
      : Response.json(answer, { status });
  });
  return all;
}

/** A plugin of its own for each engine, so one test's model list is not another's. */
const fresh: PluginFunction = (rl) => imagegen()(rl);
const harness = pluginHarness(fresh, "imagegen");

interface Made {
  provider: string;
  model: string;
  images: Array<{
    path: string;
    mimeType: string;
    byteLength: number;
    width?: number;
    height?: number;
  }>;
}

/** A connection with a key for every provider. */
const ALL_KEYS = Object.fromEntries(
  PROVIDERS.map(({ name }) => [`${name}ApiKey`, `KEY-${name}`]),
);
/** A connection with a key for every provider, whose provider is `name`. */
const through = (name: string) => ({ ...ALL_KEYS, provider: name });

/** Run code against an engine whose output directory is the test's own. */
async function run<T>(code: string, config: Record<string, unknown>) {
  const { result, error } = await harness
    .codemode(config, { outputDir: harness.tmp })
    .execute(code);
  return { result: result as T, error };
}

async function call<T>(
  action: string,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<T> {
  const { result, error } = await run<T>(
    `return await imagegen.${action}(${JSON.stringify(input)})`,
    config,
  );
  assert.equal(error, undefined);
  return result;
}

async function refused(
  action: string,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<string> {
  const { error } = await run(
    `return await imagegen.${action}(${JSON.stringify(input)})`,
    config,
  );
  assert.ok(error, "the call should fail");
  return error.split("\n")[0];
}

/** A source image on disk, for an edit. */
function source(name = "in.png"): string {
  const path = join(harness.tmp, name);
  writeFileSync(path, png(640, 480));
  return path;
}

const b64Answer = { data: [{ b64_json: B64 }] };
const WIDE = { width: 1600, height: 900 };

/** The requests that made images, without those that listed models. */
const made = (sent: Sent[]) => sent.filter(({ method }) => method === "POST");

describe("imagegen.create through each provider that answers at once", () => {
  const cases: Record<
    string,
    {
      list: [string, unknown];
      url: string;
      body: unknown;
      answer: unknown;
      key: [string, string] | "query";
    }
  > = {
    openai: {
      list: [
        "/v1/models",
        { data: [{ id: "gpt-image-2.6-flare" }, { id: "gpt-6" }] },
      ],
      url: "https://api.openai.com/v1/images/generations",
      body: {
        model: "gpt-image-2.6-flare",
        prompt: "a fox",
        n: 2,
        size: "1600x896",
        output_format: "png",
      },
      answer: b64Answer,
      key: ["authorization", "Bearer KEY-openai"],
    },
    xai: {
      list: [
        "image-generation-models",
        {
          models: [
            {
              id: "grok-imagine-image-2.0",
              input_modalities: ["text", "image"],
            },
          ],
        },
      ],
      url: "https://api.x.ai/v1/images/generations",
      body: {
        model: "grok-imagine-image-2.0",
        prompt: "a fox",
        n: 2,
        response_format: "b64_json",
        aspect_ratio: "16:9",
        resolution: "2k",
      },
      answer: b64Answer,
      key: ["authorization", "Bearer KEY-xai"],
    },
    together: {
      list: [
        "/v1/models",
        [
          { id: "black-forest-labs/FLUX.2-dev", type: "image" },
          { id: "meta/llama", type: "chat" },
        ],
      ],
      url: "https://api.together.ai/v1/images/generations",
      body: {
        model: "black-forest-labs/FLUX.2-dev",
        prompt: "a fox",
        n: 2,
        response_format: "base64",
        width: 1600,
        height: 896,
      },
      answer: b64Answer,
      key: ["authorization", "Bearer KEY-together"],
    },
    recraft: {
      list: ["never", {}],
      url: "https://external.api.recraft.ai/v1/images/generations",
      body: {
        prompt: "a fox",
        model: "recraftv4_1",
        n: 2,
        response_format: "b64_json",
        size: "16:9",
      },
      answer: b64Answer,
      key: ["authorization", "Bearer KEY-recraft"],
    },
  };

  for (const [name, { list, url, body, answer, key }] of Object.entries(
    cases,
  )) {
    it(`${name}: sends its API's request with its own key alone, and writes what it answers`, async () => {
      const sent = serve([
        ["generations", () => answer],
        [list[0], () => list[1]],
      ]);
      const result = await call<Made>(
        "create",
        { prompt: "a fox", numImages: 2, ...WIDE },
        through(name),
      );
      const [request] = made(sent);
      assert.deepEqual({ url: request.url, body: request.body }, { url, body });
      if (key !== "query") assert.equal(request.headers[key[0]], key[1]);
      for (const other of PROVIDERS)
        assert.equal(
          JSON.stringify(sent).includes(`KEY-${other.name}`),
          other.name === name,
          `${other.name}'s key in a request to ${name}`,
        );
      assert.equal(result.provider, name);
      assert.equal(result.images.length, 1);
      const [image] = result.images;
      assert.deepEqual(
        { ...image, path: dirname(image.path) },
        {
          path: harness.tmp,
          mimeType: "image/png",
          byteLength: PNG.byteLength,
          width: 1024,
          height: 768,
        },
      );
      assert.match(
        image.path,
        new RegExp(`imagegen-${name}-[0-9a-f]{16}\\.png$`),
      );
      assert.deepEqual(readFileSync(image.path), PNG);
    });
  }

  it("google: asks once for each image, with the nearest aspect ratio, and its key in the query", async () => {
    const sent = serve([
      [
        ":generateContent",
        () => ({
          candidates: [
            {
              content: {
                parts: [{ text: "here" }, { inlineData: { data: B64 } }],
              },
            },
          ],
        }),
      ],
      ["/models", () => ({ models: [] })],
    ]);
    const result = await call<Made>(
      "create",
      { prompt: "a fox", numImages: 2, ...WIDE },
      through("google"),
    );
    const requests = made(sent);
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0].url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=KEY-google",
    );
    assert.deepEqual(requests[0].body, {
      contents: [{ parts: [{ text: "a fox" }] }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        imageConfig: { aspectRatio: "16:9" },
      },
    });
    assert.equal(result.images.length, 2);
  });

  it("sends no size when none is asked for", async () => {
    const sent = serve([
      ["generations", () => b64Answer],
      ["/models", () => ({ data: [] })],
    ]);
    await call<Made>("create", { prompt: "a fox" }, through("openai"));
    assert.deepEqual(made(sent)[0].body, {
      model: "gpt-image-2.6-flare",
      prompt: "a fox",
      n: 1,
      output_format: "png",
    });
  });
});

describe("imagegen.edit", () => {
  it("openai: uploads the images as a form", async () => {
    const sent = serve([
      ["images/edits", () => b64Answer],
      ["/models", () => ({ data: [] })],
    ]);
    const result = await call<Made>(
      "edit",
      { prompt: "make it night", images: [source("a.png"), source("b.png")] },
      through("openai"),
    );
    const [request] = made(sent);
    assert.equal(request.url, "https://api.openai.com/v1/images/edits");
    assert.match(request.headers["content-type"], /^multipart\/form-data/);
    const form = String(request.body);
    for (const part of [
      'name="model"\r\n\r\ngpt-image-2.6-flare',
      'name="prompt"\r\n\r\nmake it night',
      'name="image[]"; filename="a.png"',
      'name="image[]"; filename="b.png"',
    ])
      assert.ok(form.includes(part), part);
    assert.equal(result.images.length, 1);
  });

  it("sends each provider the image in the form its API takes", async () => {
    const path = source();
    const dataUrl = `data:image/png;base64,${png(640, 480).toString("base64")}`;
    const expected: Record<string, [string, Record<string, unknown>]> = {
      xai: ["https://api.x.ai/v1/images/edits", { image: { url: dataUrl } }],
      together: [
        "https://api.together.ai/v1/images/generations",
        { image_url: dataUrl, model: "black-forest-labs/FLUX.1-kontext-pro" },
      ],
      recraft: [
        "https://external.api.recraft.ai/v1/images/imageToImage",
        { image_url: dataUrl, strength: 0.2 },
      ],
    };
    for (const [name, [url, fields]] of Object.entries(expected)) {
      const sent = serve([
        ["images/", () => b64Answer],
        ["models", () => ({})],
      ]);
      await call<Made>("edit", { prompt: "p", images: [path] }, through(name));
      const [request] = made(sent);
      assert.equal(request.url, url, name);
      const body = request.body as Record<string, unknown>;
      for (const [field, value] of Object.entries(fields))
        assert.deepEqual(body[field], value, `${name} ${field}`);
    }
  });

  it("google: sends the images inline beside the prompt", async () => {
    const sent = serve([
      [
        ":generateContent",
        () => ({
          candidates: [{ content: { parts: [{ inlineData: { data: B64 } }] } }],
        }),
      ],
      ["/models", () => ({ models: [] })],
    ]);
    await call<Made>(
      "edit",
      { prompt: "p", images: [source()] },
      through("google"),
    );
    assert.deepEqual((made(sent)[0].body as { contents: unknown }).contents, [
      {
        parts: [
          { text: "p" },
          {
            inlineData: {
              mimeType: "image/png",
              data: png(640, 480).toString("base64"),
            },
          },
        ],
      },
    ]);
  });

  it("refuses a file that is not an image, and one that is not there", async () => {
    const sent = serve([["/models", () => ({ data: [] })]]);
    // Its bytes say what a file is, so a name that ends in .png does not make one an image.
    const text = join(harness.tmp, "notes.png");
    writeFileSync(text, "not an image");
    assert.match(
      await refused("edit", { prompt: "p", images: [text] }, through("openai")),
      /notes\.png is not a PNG, JPEG or WebP image\./,
    );
    const svg = join(harness.tmp, "logo.svg");
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.match(
      await refused("edit", { prompt: "p", images: [svg] }, through("openai")),
      /logo\.svg is not a PNG, JPEG or WebP image\./,
    );
    assert.match(
      await refused(
        "edit",
        { prompt: "p", images: [join(harness.tmp, "gone.png")] },
        through("openai"),
      ),
      /gone\.png is unreadable \(ENOENT\)/,
    );
    assert.equal(made(sent).length, 0);
  });
});

describe("a provider that hosts other people's models", () => {
  /** What fal answers a queued request: its id, and where to ask about it. */
  const queued = {
    request_id: "r-1",
    status_url: "https://queue.fal.run/fal-ai/flux/requests/r-1/status",
    response_url: "https://queue.fal.run/fal-ai/flux/requests/r-1",
  };

  const falSchema = (input: Record<string, unknown>, category: string) => ({
    models: [
      {
        endpoint_id: "fal-ai/flux/schnell",
        metadata: { display_name: "FLUX.1 [schnell]", category },
        openapi: {
          components: {
            schemas: {
              QueueStatus: {},
              FluxSchnellInput: { properties: input, required: ["prompt"] },
            },
          },
        },
      },
    ],
  });

  it("fal: reads the model's schema, queues the request, and fetches the image without the key", async () => {
    const sent = serve([
      [
        "expand=openapi",
        () =>
          falSchema(
            {
              prompt: { type: "string" },
              num_images: { type: "integer" },
              image_size: {
                anyOf: [{ $ref: "#/components/schemas/ImageSize" }],
              },
            },
            "text-to-image",
          ),
      ],
      ["api.fal.ai", () => ({ models: [] })],
      ["/status", () => ({ status: "COMPLETED" })],
      [
        "/requests/r-1",
        () => ({ images: [{ url: "https://v3.fal.media/files/a.png" }] }),
      ],
      ["queue.fal.run/fal-ai/flux/schnell", () => queued],
      ["fal.media", () => PNG],
    ]);
    const result = await call<Made>(
      "create",
      { prompt: "a fox", numImages: 2, ...WIDE },
      through("fal"),
    );
    const [submit] = made(sent);
    assert.equal(submit.url, "https://queue.fal.run/fal-ai/flux/schnell");
    assert.deepEqual(submit.body, {
      prompt: "a fox",
      num_images: 2,
      image_size: { width: 1600, height: 900 },
    });
    assert.equal(submit.headers.authorization, "Key KEY-fal");
    assert.deepEqual(
      sent
        .filter(({ url }) => url.includes("/requests/"))
        .map(({ url }) => url),
      [
        "https://queue.fal.run/fal-ai/flux/requests/r-1/status",
        "https://queue.fal.run/fal-ai/flux/requests/r-1",
      ],
    );
    const download = sent.find(({ url }) => url.includes("fal.media"));
    assert.equal(download?.headers.authorization, undefined);
    assert.deepEqual(readFileSync(result.images[0].path), PNG);
    assert.equal(result.model, "fal-ai/flux/schnell");
  });

  it("fal: asks once for the schema of a model its list does not hold", async () => {
    const sent = serve([
      [
        "expand=openapi",
        () => ({
          models: [
            {
              endpoint_id: "fal-ai/unlisted",
              metadata: { category: "text-to-image" },
              openapi: {
                components: {
                  schemas: { UnlistedInput: { properties: { prompt: {} } } },
                },
              },
            },
          ],
        }),
      ],
      ["api.fal.ai", () => ({ models: [] })],
      ["/status", () => ({ status: "COMPLETED" })],
      [
        "/requests/r-1",
        () => ({ images: [{ url: "https://fal.media/files/a.png" }] }),
      ],
      ["queue.fal.run", () => queued],
      ["fal.media", () => PNG],
    ]);
    const result = await call<Made>(
      "create",
      { prompt: "p", model: "fal-ai/unlisted" },
      through("fal"),
    );
    assert.equal(result.model, "fal-ai/unlisted");
    assert.equal(
      sent.filter(({ url }) => url.includes("expand=openapi")).length,
      1,
    );
  });

  it("fal: asks about a request only where fal says to", async () => {
    serve([
      [
        "expand=openapi",
        () => falSchema({ prompt: { type: "string" } }, "text-to-image"),
      ],
      ["api.fal.ai", () => ({ models: [] })],
      [
        "queue.fal.run",
        () => ({ ...queued, status_url: "https://evil.example/r-1/status" }),
      ],
    ]);
    assert.match(
      await refused("create", { prompt: "p" }, through("fal")),
      /fal answered no address to ask about the request at\./,
    );
  });

  it("fal: refuses a size the model has no field for, before queueing anything", async () => {
    const sent = serve([
      [
        "expand=openapi",
        () => falSchema({ prompt: { type: "string" } }, "text-to-image"),
      ],
      ["api.fal.ai", () => ({ models: [] })],
    ]);
    assert.equal(
      await refused("create", { prompt: "p", ...WIDE }, through("fal")),
      "Error: fal-ai/flux/schnell takes no size. Leave width and height out.",
    );
    assert.equal(made(sent).length, 0);
  });

  it("refuses an image that is somewhere the provider's images do not come from", async () => {
    serve([
      [
        "expand=openapi",
        () => falSchema({ prompt: { type: "string" } }, "text-to-image"),
      ],
      ["api.fal.ai", () => ({ models: [] })],
      ["/status", () => ({ status: "COMPLETED" })],
      [
        "/requests/r-1",
        () => ({ images: [{ url: "https://evil.example/a.png" }] }),
      ],
      ["queue.fal.run", () => queued],
    ]);
    assert.match(
      await refused("create", { prompt: "p" }, through("fal")),
      /fal answered an image somewhere this package does not fetch from\./,
    );
  });

  it("replicate: reads the model's schema, waits for the prediction, and fetches the image", async () => {
    let asked = 0;
    const sent = serve([
      ["/collections/", () => ({ models: [] })],
      [
        "/models/black-forest-labs/flux-schnell",
        () => ({
          owner: "black-forest-labs",
          name: "flux-schnell",
          latest_version: {
            id: "v9",
            openapi_schema: {
              components: {
                schemas: {
                  Input: {
                    properties: {
                      prompt: { type: "string" },
                      num_outputs: { type: "integer" },
                      aspect_ratio: {
                        allOf: [{ $ref: "#/components/schemas/aspect_ratio" }],
                      },
                    },
                  },
                  aspect_ratio: {
                    type: "string",
                    enum: ["1:1", "16:9", "9:16"],
                  },
                },
              },
            },
          },
        }),
      ],
      [
        "/predictions/p-1",
        () => {
          asked++;
          return {
            id: "p-1",
            status: "succeeded",
            output: ["https://replicate.delivery/x/out.png"],
          };
        },
      ],
      ["/predictions", () => ({ id: "p-1", status: "starting" })],
      ["replicate.delivery", () => PNG],
    ]);
    const result = await call<Made>(
      "create",
      { prompt: "a fox", ...WIDE },
      through("replicate"),
    );
    const [create] = made(sent);
    assert.equal(create.url, "https://api.replicate.com/v1/predictions");
    assert.equal(create.headers.prefer, "wait");
    assert.deepEqual(create.body, {
      version: "black-forest-labs/flux-schnell:v9",
      input: { prompt: "a fox", num_outputs: 1, aspect_ratio: "16:9" },
    });
    assert.equal(asked, 1);
    assert.equal(result.images.length, 1);
  });
});

describe("replicate", () => {
  const flux = {
    owner: "black-forest-labs",
    name: "flux-schnell",
    latest_version: {
      id: "v9",
      openapi_schema: {
        components: { schemas: { Input: { properties: { prompt: {} } } } },
      },
    },
  };

  it("ends the wait when a prediction ends without an output", async () => {
    for (const status of ["failed", "canceled", "aborted"]) {
      serve([
        ["/collections/", () => ({ models: [] })],
        ["/models/", () => flux],
        ["/predictions", () => ({ id: "p-1", status })],
      ]);
      assert.match(
        await refused("create", { prompt: "p" }, through("replicate")),
        new RegExp(`replicate prediction p-1 ${status}\\.`),
      );
    }
  });

  it("lists what a search finds by its tags: the image models, and what each does", async () => {
    serve([
      ["/collections/", () => ({ models: [] })],
      [
        "/search",
        () => ({
          models: [
            {
              model: { owner: "google", name: "nano-banana" },
              metadata: { tags: ["text-to-image", "image-editing"] },
            },
            {
              model: { owner: "acme", name: "upscaler" },
              metadata: { tags: ["image-to-image"] },
            },
            {
              model: { owner: "meta", name: "llama" },
              metadata: { tags: ["language-model"] },
            },
          ],
        }),
      ],
    ]);
    const found = await call<{ models: unknown[] }>(
      "models",
      { query: "banana" },
      through("replicate"),
    );
    assert.deepEqual(found.models, [
      { id: "google/nano-banana", create: true, edit: true },
      { id: "acme/upscaler", create: false, edit: true },
    ]);
  });
});

describe("imagegen.models", () => {
  it("lays the provider's own list over the models the package knows, and says each action's default", async () => {
    const sent = serve([
      [
        "image-generation-models",
        () => ({
          models: [
            { id: "grok-imagine-image-2.0", input_modalities: ["text"] },
            { id: "grok-imagine-image-3", input_modalities: ["text", "image"] },
          ],
        }),
      ],
    ]);
    assert.deepEqual(await call("models", {}, through("xai")), {
      provider: "xai",
      createModel: "grok-imagine-image-2.0",
      editModel: "grok-imagine-image-2.0",
      models: [
        { id: "grok-imagine-image-2.0", create: true, edit: false },
        { id: "grok-imagine-image-3", create: true, edit: true },
      ],
    });
    assert.equal(sent[0].url, "https://api.x.ai/v1/image-generation-models");
  });

  it("keeps the list for the connection, so a request does not ask for it again", async () => {
    const sent = serve([
      ["generations", () => b64Answer],
      ["image-generation-models", () => ({ models: [] })],
    ]);
    const { error } = await run(
      `await imagegen.models({});
       await imagegen.create({ prompt: "a" });
       await imagegen.create({ prompt: "b" });`,
      through("xai"),
    );
    assert.equal(error, undefined);
    assert.deepEqual(
      sent.map(({ url }) => url.split("/v1/")[1]),
      ["image-generation-models", "images/generations", "images/generations"],
    );
  });

  it("answers the models the package knows when the provider cannot be asked", async () => {
    stubFetch(async () => Response.json({}, { status: 500 }));
    const listed = await call<{ models: Array<{ id: string }> }>(
      "models",
      {},
      through("openai"),
    );
    assert.deepEqual(listed.models.map(({ id }) => id).slice(0, 2), [
      "gpt-image-2.6-flare",
      "gpt-image-2.6-sunburst",
    ]);
  });

  it("finds models by words, and returns no more than asked", async () => {
    serve([["never", () => ({})]]);
    const all = await call<{ models: Array<{ id: string }> }>(
      "models",
      {},
      through("recraft"),
    );
    assert.equal(all.models.length, 17);
    assert.deepEqual(
      (
        await call<{ models: Array<{ id: string }> }>(
          "models",
          { query: "v4_1 vector" },
          through("recraft"),
        )
      ).models.map(({ id }) => id),
      [
        "recraftv4_1_vector",
        "recraftv4_1_pro_vector",
        "recraftv4_1_utility_vector",
        "recraftv4_1_utility_pro_vector",
      ],
    );
    assert.equal(
      (
        await call<{ models: unknown[] }>(
          "models",
          { limit: 3 },
          through("recraft"),
        )
      ).models.length,
      3,
    );
  });

  it("searches a provider with thousands of models for what its list does not hold", async () => {
    const sent = serve([
      [
        "q=banana",
        () => ({
          models: [
            {
              endpoint_id: "fal-ai/nano-banana-pro",
              metadata: {
                display_name: "Nano Banana Pro",
                category: "text-to-image",
              },
            },
            {
              endpoint_id: "fal-ai/kling",
              metadata: { category: "text-to-video" },
            },
          ],
        }),
      ],
      ["api.fal.ai", () => ({ models: [] })],
    ]);
    const found = await call<{ models: Array<{ id: string }> }>(
      "models",
      { query: "banana" },
      through("fal"),
    );
    assert.deepEqual(found.models, [
      {
        id: "fal-ai/nano-banana-pro",
        name: "Nano Banana Pro",
        create: true,
        edit: false,
      },
    ]);
    assert.ok(sent.some(({ url }) => url.includes("category=image-to-image")));
  });
});

describe("the model a request uses", () => {
  const xaiList = (): [string, () => unknown] => [
    "image-generation-models",
    () => ({
      models: [{ id: "grok-imagine-image-2.0", input_modalities: ["text"] }],
    }),
  ];

  it("is the call's, else the connection's, else the provider's", async () => {
    const sent = serve([
      ["generations", () => b64Answer],
      [
        "/models",
        () => ({ data: [{ id: "gpt-image-2" }, { id: "gpt-image-1.5" }] }),
      ],
    ]);
    const config = { ...through("openai"), createModel: "gpt-image-2" };
    const models = async (
      input: Record<string, unknown>,
      c: Record<string, unknown> = config,
    ) => (await call<Made>("create", { prompt: "p", ...input }, c)).model;
    assert.deepEqual(
      [
        await models({ model: "gpt-image-1.5" }),
        await models({}),
        await models({}, through("openai")),
      ],
      ["gpt-image-1.5", "gpt-image-2", "gpt-image-2.6-flare"],
    );
    assert.equal(
      (made(sent)[0].body as { model: string }).model,
      "gpt-image-1.5",
    );
  });

  it("is refused before anything is made when the provider has no such model", async () => {
    const sent = serve([xaiList()]);
    assert.equal(
      await refused("create", { prompt: "p", model: "grok-9" }, through("xai")),
      'Error: imagegen: xai has no image model "grok-9". List its models with imagegen.models().',
    );
    assert.equal(made(sent).length, 0);
  });

  it("is refused when it cannot do what the action does", async () => {
    const sent = serve([xaiList()]);
    assert.equal(
      await refused(
        "edit",
        { prompt: "p", images: [source()] },
        through("xai"),
      ),
      "Error: imagegen: grok-imagine-image-2.0 cannot edit images. List the models that can with imagegen.models().",
    );
    assert.equal(made(sent).length, 0);
  });

  it("is left to the provider to judge when its models could not be listed", async () => {
    const sent = serve([
      ["generations", () => b64Answer],
      [
        "image-generation-models",
        () => {
          throw new Error("down");
        },
      ],
    ]);
    const result = await call<Made>(
      "create",
      { prompt: "p", model: "grok-new" },
      through("xai"),
    );
    assert.equal(result.model, "grok-new");
    assert.equal((made(sent)[0].body as { model: string }).model, "grok-new");
  });
});

describe("the provider a request uses", () => {
  it("is the first with a key, in the providers' order", async () => {
    serve([
      ["generations", () => b64Answer],
      ["models", () => ({})],
    ]);
    const result = await call<Made>(
      "create",
      { prompt: "p" },
      { togetherApiKey: "t", xaiApiKey: "x" },
    );
    assert.equal(result.provider, "xai");
  });

  it("is never the call's: no action has an input that names one", async () => {
    serve([]);
    for (const [action, input] of [
      ["create", { prompt: "p", provider: "xai" }],
      ["models", { provider: "xai" }],
    ] as const)
      assert.match(
        await refused(action, input, ALL_KEYS),
        new RegExp(`Invalid input for imagegen\\.${action}`),
      );
  });

  it("is refused when no provider has a key, or the connection's has none", async () => {
    serve([]);
    const none = await refused("create", { prompt: "p" }, {});
    assert.match(none, /imagegen: no image provider has a key\. Set one of /);
    for (const { env } of PROVIDERS) assert.ok(none.includes(env), env);
    assert.equal(
      await refused("models", {}, { xaiApiKey: "x", provider: "openai" }),
      "Error: imagegen: no key for openai, the connection's provider. Set OPENAI_API_KEY.",
    );
  });
});

describe("what a request accepts", () => {
  it("refuses one side of a size without the other", async () => {
    serve([]);
    assert.equal(
      await refused("create", { prompt: "p", width: 1024 }, ALL_KEYS),
      "Error: imagegen: set width and height together, or neither.",
    );
  });

  it("refuses a value in another form than the one each input has", async () => {
    const sent = serve([]);
    for (const input of [
      { prompt: "" },
      { prompt: "p", numImages: 5 },
      { prompt: "p", width: 100, height: 100 },
      { prompt: "p", width: 1024.5, height: 1024 },
      { prompt: "p", size: "1024x1024" },
      { prompt: "p", aspectRatio: "16:9" },
    ])
      assert.match(
        await refused("create", input, ALL_KEYS),
        /Invalid input for imagegen\.create/,
        JSON.stringify(input),
      );
    assert.match(
      await refused("edit", { prompt: "p", images: [] }, ALL_KEYS),
      /Invalid input for imagegen\.edit/,
    );
    assert.equal(sent.length, 0);
  });
});

describe("a provider that fails", () => {
  it("is reported by provider and status, without what it answered", async () => {
    serve(
      [
        ["generations", () => ({ error: "the key KEY-xai is not valid" })],
        ["models", () => ({})],
      ],
      401,
    );
    const error = await refused("create", { prompt: "p" }, through("xai"));
    assert.equal(error, "Error: imagegen.xai: request failed (HTTP 401)");
  });

  it("is refused when it answers no image, or something that is no image", async () => {
    serve([
      ["generations", () => ({ data: [] })],
      ["models", () => ({})],
    ]);
    assert.match(
      await refused("create", { prompt: "p" }, through("xai")),
      /grok-imagine-image-2\.0 answered no image\. It may have refused the prompt\./,
    );
    serve([
      [
        "generations",
        () => ({
          data: [
            { b64_json: Buffer.from("not an image at all").toString("base64") },
          ],
        }),
      ],
      ["models", () => ({})],
    ]);
    assert.match(
      await refused("create", { prompt: "p" }, through("xai")),
      /answered something that is no image\./,
    );
  });
});

describe("a provider a host adds", () => {
  const acme: ImageProvider = {
    name: "acme",
    env: "ACME_IMAGE_KEY",
    key: { header: "X-Acme-Key" },
    targets: {
      acme: { baseUrl: "https://images.acme.example/", methods: ["POST"] },
    },
    defaults: { create: "acme-1" },
    models: [{ id: "acme-1", create: true, edit: false }],
    generate: async (api, { prompt, model }) => {
      const { image } = await api.request<{ image: string }>({
        path: "make",
        method: "POST",
        json: { prompt, model: model.id },
      });
      return [{ base64: image }];
    },
  };
  const extended = pluginHarness(imagegen([acme, ...PROVIDERS]), "imagegen");

  it("is used like the others, with a key of its own", async () => {
    const sent = serve([["acme.example", () => ({ image: B64 })]]);
    const { result, error } = await extended
      .codemode(
        { ...ALL_KEYS, acmeApiKey: "KEY-acme" },
        { outputDir: extended.tmp },
      )
      .execute('return await imagegen.create({ prompt: "p" })');
    assert.equal(error, undefined);
    assert.equal((result as Made).provider, "acme");
    assert.equal(sent[0].headers["x-acme-key"], "KEY-acme");
    assert.ok(!JSON.stringify(sent).includes("KEY-openai"));
  });
});

describe("a size in pixels", () => {
  it("becomes the nearest of a model's sizes: the nearest shape, then the nearest area", () => {
    const sizes = [
      { width: 1024, height: 1024 },
      { width: 1536, height: 1024 },
      { width: 1024, height: 1536 },
    ];
    assert.deepEqual(
      nearestSize({ width: 1600, height: 900 }, sizes),
      sizes[1],
    );
    assert.deepEqual(nearestSize({ width: 500, height: 520 }, sizes), sizes[0]);
    assert.deepEqual(
      nearestSize({ width: 900, height: 1600 }, sizes),
      sizes[2],
    );
  });

  it("becomes the nearest of a model's aspect ratios", () => {
    const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16"];
    assert.equal(nearestRatio({ width: 1920, height: 1080 }, ratios), "16:9");
    assert.equal(nearestRatio({ width: 1000, height: 800 }, ratios), "4:3");
    assert.equal(nearestRatio({ width: 512, height: 512 }, ratios), "1:1");
    assert.equal(nearestRatio({ width: 600, height: 1200 }, ratios), "9:16");
  });

  it("is brought within a model's bounds with its shape kept", () => {
    const bounds = {
      multiple: 16,
      maxSide: 3840,
      minPixels: 655_360,
      maxPixels: 8_294_400,
    };
    assert.deepEqual(fitSize({ width: 1600, height: 900 }, bounds), {
      width: 1600,
      height: 896,
    });
    const small = fitSize({ width: 512, height: 512 }, bounds);
    assert.ok(
      small.width * small.height >= bounds.minPixels,
      JSON.stringify(small),
    );
    assert.equal(small.width, small.height);
    const large = fitSize({ width: 4096, height: 4096 }, bounds);
    assert.ok(
      large.width * large.height <= bounds.maxPixels,
      JSON.stringify(large),
    );
    assert.ok(large.width <= 3840 && large.width % 16 === 0);
  });

  it("is kept within a model's bounds whatever is asked for", () => {
    const bounds = {
      multiple: 16,
      maxSide: 3840,
      minPixels: 655_360,
      maxPixels: 8_294_400,
      maxRatio: 3,
    };
    assert.deepEqual(fitSize({ width: 4096, height: 256 }, bounds), {
      width: 1392,
      height: 480,
    });
    for (let width = 256; width <= 4096; width += 96)
      for (let height = 256; height <= 4096; height += 96) {
        const fitted = fitSize({ width, height }, bounds);
        const [longer, shorter] = [
          Math.max(fitted.width, fitted.height),
          Math.min(fitted.width, fitted.height),
        ];
        const pixels = fitted.width * fitted.height;
        assert.ok(
          fitted.width % 16 === 0 &&
            fitted.height % 16 === 0 &&
            longer <= bounds.maxSide &&
            longer <= shorter * bounds.maxRatio &&
            pixels >= bounds.minPixels &&
            pixels <= bounds.maxPixels,
          `${width}x${height} became ${fitted.width}x${fitted.height}`,
        );
      }
  });
});

describe("an image's first bytes", () => {
  it("tell its type and size", () => {
    assert.deepEqual(imageFacts(png(640, 480)), {
      mimeType: "image/png",
      width: 640,
      height: 480,
    });
    const gif = Buffer.alloc(16);
    gif.write("GIF89a");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    assert.deepEqual(imageFacts(gif), {
      mimeType: "image/gif",
      width: 320,
      height: 200,
    });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x00, 0x00,
    ]);
    assert.deepEqual(imageFacts(jpeg), {
      mimeType: "image/jpeg",
      width: 640,
      height: 480,
    });
    const webp = Buffer.alloc(30);
    webp.write("RIFF");
    webp.write("WEBP", 8);
    webp.write("VP8X", 12);
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    assert.deepEqual(imageFacts(webp), {
      mimeType: "image/webp",
      width: 800,
      height: 600,
    });
    assert.deepEqual(
      imageFacts(
        Buffer.from(
          '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
      ),
      { mimeType: "image/svg+xml" },
    );
    assert.equal(imageFacts(Buffer.from("plain text, long enough")), undefined);
  });
});

describe("a hosted model's schema", () => {
  const request = {
    prompt: "p",
    model: { id: "m", create: true, edit: true },
    numImages: 2,
    size: { width: 1600, height: 900 },
    images: [],
  };
  const image = {
    bytes: new Uint8Array([0]),
    mimeType: "image/png",
    fileName: "a.png",
  };
  const dataUrl = "data:image/png;base64,AA==";

  it("says which fields take the count, the size and the images", () => {
    assert.deepEqual(
      fieldsOf(
        {
          properties: {
            prompt: {},
            num_outputs: {},
            width: {},
            height: {},
            input_image: { type: "string" },
          },
          required: ["prompt", "input_image"],
        },
        {},
      ),
      {
        prompt: "prompt",
        count: "num_outputs",
        images: { name: "input_image", many: false, required: true },
        size: { kind: "pair" },
      },
    );
    assert.equal(fieldsOf({ properties: { text: {} } }, {}), undefined);
  });

  it("writes a request as the model's input", () => {
    const pair = fieldsOf(
      { properties: { prompt: {}, n: {}, width: {}, height: {} } },
      {},
    );
    assert.ok(pair);
    assert.deepEqual(inputFor(pair, request), {
      prompt: "p",
      n: 2,
      width: 1600,
      height: 900,
    });
    const sizes = fieldsOf(
      {
        properties: { prompt: {}, size: { enum: ["1024x1024", "1536x1024"] } },
      },
      {},
    );
    assert.ok(sizes);
    assert.deepEqual(inputFor(sizes, { ...request, numImages: 1 }), {
      prompt: "p",
      size: "1536x1024",
    });
    const many = fieldsOf(
      { properties: { prompt: {}, image_urls: { type: "array" } } },
      {},
    );
    assert.ok(many);
    assert.deepEqual(
      inputFor(many, {
        ...request,
        numImages: 1,
        size: undefined,
        images: [image, image],
      }),
      { prompt: "p", image_urls: [dataUrl, dataUrl] },
    );
  });

  it("refuses a part of a request the model has no field for", () => {
    const bare = fieldsOf(
      { properties: { prompt: {}, image_url: { type: "string" } } },
      {},
    );
    assert.ok(bare);
    assert.throws(() => inputFor(bare, request), /m makes one image a request/);
    assert.throws(
      () => inputFor(bare, { ...request, numImages: 1 }),
      /m takes no size/,
    );
    assert.throws(
      () =>
        inputFor(bare, {
          ...request,
          numImages: 1,
          size: undefined,
          images: [image, image],
        }),
      /m takes one image/,
    );
  });
});

describe("the README", () => {
  it("lists the providers in their order, with each key and whether its models are listed live", () => {
    const readme = readFileSync(join(PACKAGE, "README.md"), "utf8");
    const rows = [
      ...readme.matchAll(/^\| `(\w+)` \| `(\w+)` \| (Yes|No) \|/gm),
    ].map(([, name, env, live]) => [name, env, live]);
    assert.deepEqual(
      rows,
      PROVIDERS.map(({ name, env, listModels }) => [
        name,
        env,
        listModels ? "Yes" : "No",
      ]),
    );
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-imagegen",
  plugin: "imagegen",
  actions: 3,
  write: 2,
});
