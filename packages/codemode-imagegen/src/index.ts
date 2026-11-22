/**
 * Image generation for codemode: make an image from a prompt, or edit
 * images with one, through the provider the connection chooses, and list
 * that provider's models to choose among.
 *
 *   const { images } = await imagegen.create({ prompt: "a red bicycle on snow" })
 *   // images[0].path -> a file in the host's output directory
 *
 * A connection holds a key per provider. Each key is declared with the
 * addresses that may receive it, so a request to one provider sends no other
 * provider's key. Code never names a provider.
 */

import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ActionContext,
  type CodemodePluginAPI,
  type CredentialDeclaration,
  type CredentialTarget,
  credentialJson,
  downloadResource,
  type PluginFunction,
  readLocalFile,
  staticCredential,
  writeOutputFile,
} from "@shiftlabs/codemode";
import { packageVersion } from "@shiftlabs/codemode/utils/cli";
import * as t from "typebox";
import { EXTENSIONS, imageFacts } from "./image.js";
import { PROVIDERS } from "./providers/index.js";
import type {
  ImageModel,
  ImageProvider,
  ProducedImage,
  ProviderApi,
  SourceImage,
} from "./types.js";

export * from "./providers/index.js";
export type { Size } from "./size.js";
export * from "./types.js";

const NAME = "imagegen";
const MAX_IMAGES = 4;
const MAX_SOURCES = 8;
const MIN_SIDE = 256;
const MAX_SIDE = 4096;
/** Larger than any provider takes inline. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_LISTED = 200;
const DEFAULT_LISTED = 50;
/** A provider may take minutes to make an image. A host caps this at its own ceiling. */
const TIMEOUT_MS = 5 * 60_000;
/** How long a provider's list of models is kept before it is asked for again. */
const MODELS_TTL_MS = 10 * 60_000;

/** What `create` and `edit` do, by the name of the action. */
type Kind = "create" | "edit";

/** The connection field that holds a provider's key. */
function keyField(provider: ImageProvider): string {
  return `${provider.name}ApiKey`;
}

/** Whether the connection holds a key for the provider. */
function hasKey(
  provider: ImageProvider,
  config: Readonly<Record<string, unknown>>,
): boolean {
  return Boolean(config[keyField(provider)]);
}

/**
 * One credential for every provider: a part per provider, each optional and
 * each placed only on that provider's targets, so a connection holds the
 * keys it has and a key is sent to its own provider alone.
 */
function credentialOf(providers: ImageProvider[]): CredentialDeclaration {
  const names = providers.map((provider) => provider.name);
  return staticCredential({
    id: "codemodeImagegen",
    auth: {
      kind: "static",
      parts: names,
      optionalParts: names,
      placements: providers.map(({ name, key, targets }) =>
        "query" in key
          ? {
              in: "query",
              part: name,
              name: key.query,
              targets: Object.keys(targets),
            }
          : {
              in: "header",
              part: name,
              name: key.header,
              ...(key.prefix === undefined ? {} : { prefix: key.prefix }),
              targets: Object.keys(targets),
            },
      ),
    },
    local: Object.fromEntries(
      providers.map((provider) => [provider.name, keyField(provider)]),
    ),
    targets: Object.fromEntries(
      providers.flatMap((provider) =>
        Object.entries(provider.targets).map(
          ([name, target]): [string, CredentialTarget] => [
            name,
            { ...target, timeoutMs: TIMEOUT_MS },
          ],
        ),
      ),
    ),
  });
}

/**
 * The provider a request goes to. The connection decides, never the call:
 * its `provider` when it names one, else the first provider it has a key
 * for. A host that signs requests keeps the keys, so only a connection that
 * signs for itself (`signsItself`) is asked to hold the key of the provider
 * it names.
 */
function chosen(
  providers: ImageProvider[],
  config: Readonly<Record<string, unknown>>,
  signsItself: boolean,
): ImageProvider {
  const name = config.provider;
  if (name === undefined) {
    const first = providers.find((candidate) => hasKey(candidate, config));
    if (first) return first;
    throw new Error(
      `${NAME}: no image provider has a key. Set one of ${providers.map((candidate) => candidate.env).join(", ")}, or the connection's "provider" when the host keeps the keys.`,
    );
  }
  const provider = providers.find((candidate) => candidate.name === name);
  if (!provider)
    throw new Error(
      `${NAME}: the connection names the provider ${JSON.stringify(name)}. The providers are ${providers.map((candidate) => candidate.name).join(", ")}.`,
    );
  if (signsItself && !hasKey(provider, config))
    throw new Error(
      `${NAME}: no key for ${provider.name}, the connection's provider. Set ${provider.env}.`,
    );
  return provider;
}

/** The model an action uses when the call names none: the connection's, else the provider's. */
function defaultModel(
  provider: ImageProvider,
  config: Readonly<Record<string, unknown>>,
  kind: Kind,
): string | undefined {
  const configured = config[`${kind}Model`];
  return typeof configured === "string" && configured
    ? configured
    : provider.defaults[kind];
}

/** A model as an action answers it: what the provider's own fields for it are stay inside. */
function described({ id, name, description, create, edit }: ImageModel) {
  return {
    id,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    create,
    edit,
  };
}

/** The types of image a model edits. */
const SOURCE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Read an image to edit. What it is, its bytes say: a file that is none of the types a model edits is refused. */
async function sourceImage(path: string): Promise<SourceImage> {
  const bytes = await readLocalFile(path, {
    subject: `${NAME}: ${path}`,
    maxBytes: MAX_SOURCE_BYTES,
    oversize: `${NAME}: ${path} is larger than ${MAX_SOURCE_BYTES / (1024 * 1024)} MiB`,
  });
  const facts = imageFacts(bytes);
  if (!facts || !SOURCE_TYPES.includes(facts.mimeType))
    throw new Error(`${NAME}: ${path} is not a PNG, JPEG, WebP or GIF image.`);
  return { bytes, mimeType: facts.mimeType, fileName: basename(path) };
}

const sizeInputs = {
  width: t.Optional(
    t.Integer({
      minimum: MIN_SIDE,
      maximum: MAX_SIDE,
      description: `Width in pixels, from ${MIN_SIDE} to ${MAX_SIDE}. Set with height, or leave both out for the model's own size`,
    }),
  ),
  height: t.Optional(
    t.Integer({
      minimum: MIN_SIDE,
      maximum: MAX_SIDE,
      description: `Height in pixels, from ${MIN_SIDE} to ${MAX_SIDE}. Set with width. A model that takes other sizes makes the nearest one, and each image says its own`,
    }),
  ),
};

const numImages = t.Optional(
  t.Integer({
    minimum: 1,
    maximum: MAX_IMAGES,
    description: `How many images to make, from 1 to ${MAX_IMAGES}. The default is 1`,
  }),
);

const modelInput = (kind: Kind) =>
  t.Optional(
    t.String({
      minLength: 1,
      description: `A model id from ${NAME}.models() that can ${kind}. The default is the connection's`,
    }),
  );

const imagesOutput = {
  type: "object",
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          mimeType: { type: "string" },
          byteLength: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
        },
        required: ["path", "mimeType", "byteLength"],
      },
    },
  },
  required: ["provider", "model", "images"],
};

/**
 * The `imagegen` plugin over `providers`, in the order one is chosen when
 * the connection names none. A host adds a provider of its own by passing a
 * list that includes it.
 */
export function imagegen(
  providers: ImageProvider[] = PROVIDERS,
): PluginFunction {
  const credential = credentialOf(providers);
  const names = providers.map((provider) => provider.name);
  /** Each provider's models, by the connection that listed them, with when the list was made. */
  const lists = new Map<string, { at: number; models: ImageModel[] }>();
  /** A provider's models, and whether the provider itself could be asked for them. */
  interface Listed {
    models: ImageModel[];
    asked: boolean;
  }

  function apiOf(ctx: ActionContext, provider: ImageProvider): ProviderApi {
    const [first] = Object.keys(provider.targets);
    return {
      request: ({ target, ...call }) =>
        credentialJson(ctx, credential, `${NAME}.${provider.name}`, {
          target: target ?? first,
          ...call,
        }),
      wait: async (ms) => {
        await sleep(ms, undefined, { signal: ctx.signal });
      },
    };
  }

  /**
   * A provider's models: the ones the package knows of, with the provider's
   * own list laid over them. The provider is asked once in a while, and one
   * that cannot be asked leaves the known ones, to be asked again next time.
   */
  async function modelsOf(
    ctx: ActionContext,
    provider: ImageProvider,
  ): Promise<Listed> {
    const key = `${ctx.connection.name}\0${provider.name}`;
    const kept = lists.get(key);
    if (kept && Date.now() - kept.at < MODELS_TTL_MS)
      return { models: kept.models, asked: true };
    const byId = new Map(provider.models.map((model) => [model.id, model]));
    try {
      const live = await provider.listModels?.(apiOf(ctx, provider));
      for (const model of live ?? []) byId.set(model.id, model);
    } catch {
      return { models: [...byId.values()], asked: false };
    }
    const models = [...byId.values()];
    lists.set(key, { at: Date.now(), models });
    return { models, asked: true };
  }

  /** The model a request uses, checked against the provider's models before anything is made. */
  async function modelFor(
    ctx: ActionContext,
    provider: ImageProvider,
    named: string | undefined,
    kind: Kind,
  ): Promise<ImageModel> {
    const id = named ?? defaultModel(provider, ctx.connection.config, kind);
    if (!id)
      throw new Error(
        `${NAME}: ${provider.name} has no model to ${kind} with by default. Pass one from ${NAME}.models().`,
      );
    const { models, asked } = await modelsOf(ctx, provider);
    const model =
      models.find((listed) => listed.id === id) ??
      (await provider.findModel?.(apiOf(ctx, provider), id)) ??
      // A provider that could not be asked for its models judges the id itself.
      (asked ? undefined : { id, create: true, edit: true });
    if (!model)
      throw new Error(
        `${NAME}: ${provider.name} has no image model ${JSON.stringify(id)}. List its models with ${NAME}.models().`,
      );
    if (!model[kind])
      throw new Error(
        `${NAME}: ${id} cannot ${kind} images. List the models that can with ${NAME}.models().`,
      );
    return model;
  }

  /** An image's bytes, fetched without the key from one of the provider's download hosts when it is a link. */
  async function bytesOf(
    provider: ImageProvider,
    produced: ProducedImage,
  ): Promise<Uint8Array> {
    if ("base64" in produced) return Buffer.from(produced.base64, "base64");
    const url = new URL(produced.url);
    if (
      !provider.downloads?.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
    )
      throw new Error(
        `${NAME}: ${provider.name} answered an image somewhere this package does not fetch from.`,
      );
    const response = await downloadResource(url.href, {
      allowedOrigins: [url.origin],
      fetch: globalThis.fetch,
    });
    if (!response.ok)
      throw new Error(
        `${NAME}: the image could not be fetched (HTTP ${response.status}).`,
      );
    return new Uint8Array(await response.arrayBuffer());
  }

  async function make(
    ctx: ActionContext,
    kind: Kind,
    input: {
      prompt: string;
      model?: string;
      width?: number;
      height?: number;
      numImages?: number;
      images?: string[];
    },
  ) {
    if ((input.width === undefined) !== (input.height === undefined))
      throw new Error(`${NAME}: set width and height together, or neither.`);
    const provider = chosen(providers, ctx.connection.config, !ctx.credentials);
    const model = await modelFor(ctx, provider, input.model, kind);
    const images = await Promise.all((input.images ?? []).map(sourceImage));
    const produced = await provider.generate(apiOf(ctx, provider), {
      prompt: input.prompt,
      model,
      numImages: input.numImages ?? 1,
      ...(input.width !== undefined && input.height !== undefined
        ? { size: { width: input.width, height: input.height } }
        : {}),
      images,
    });
    if (!produced.length)
      throw new Error(
        `${NAME}: ${model.id} answered no image. It may have refused the prompt.`,
      );
    const written = [];
    for (const one of produced) {
      const bytes = await bytesOf(provider, one);
      const facts = imageFacts(bytes);
      if (!facts)
        throw new Error(
          `${NAME}: ${model.id} answered something that is no image.`,
        );
      written.push({
        path: writeOutputFile(
          `${NAME}-${provider.name}`,
          EXTENSIONS[facts.mimeType],
          bytes,
          ctx.outputDir,
        ),
        mimeType: facts.mimeType,
        byteLength: bytes.byteLength,
        ...(facts.width && facts.height
          ? { width: facts.width, height: facts.height }
          : {}),
      });
    }
    return { provider: provider.name, model: model.id, images: written };
  }

  return function plugin(rl: CodemodePluginAPI): void {
    rl.setName(NAME);
    rl.setVersion(packageVersion(import.meta.url));
    rl.setDescription(
      "Make and edit images through the image provider the connection chooses, and list its models.",
    );
    rl.setCredential(credential);
    rl.setConnectionSchema(
      t.Object({
        provider: t.Optional(
          t.String({
            enum: names,
            description:
              "The provider every request goes to. The default is the first provider with a key",
          }),
        ),
        createModel: t.Optional(
          t.String({
            description:
              "The model create uses when a call names none. The default is the provider's",
          }),
        ),
        editModel: t.Optional(
          t.String({
            description:
              "The model edit uses when a call names none. The default is the provider's",
          }),
        ),
        ...Object.fromEntries(
          providers.map((provider) => [
            keyField(provider),
            t.Optional(
              t.String({
                env: provider.env,
                description: `API key for ${provider.name}`,
              }),
            ),
          ]),
        ),
      }),
    );

    rl.registerAction("create", {
      access: "write",
      description:
        "Make images from a prompt. Writes each image to a file and returns its path, type and size in pixels. Billed by the provider.",
      hints: { openWorld: true },
      inputSchema: t.Object(
        {
          prompt: t.String({
            minLength: 1,
            description: "What the image shows. Be specific and descriptive",
          }),
          model: modelInput("create"),
          ...sizeInputs,
          numImages,
        },
        { additionalProperties: false },
      ),
      outputSchema: imagesOutput,
      execute: (input, ctx) => make(ctx, "create", input),
    });

    rl.registerAction("edit", {
      access: "write",
      description:
        "Make images from a prompt and existing images: change one, or combine several. Writes each image to a file and returns its path, type and size in pixels. Billed by the provider.",
      hints: { openWorld: true },
      inputSchema: t.Object(
        {
          prompt: t.String({
            minLength: 1,
            description: "What to change, or what to make of the images",
          }),
          images: t.Array(t.String({ minLength: 1 }), {
            minItems: 1,
            maxItems: MAX_SOURCES,
            description: `Paths of 1 to ${MAX_SOURCES} image files (PNG, JPEG, WebP or GIF) to edit. Some models take one`,
          }),
          model: modelInput("edit"),
          ...sizeInputs,
          numImages,
        },
        { additionalProperties: false },
      ),
      outputSchema: imagesOutput,
      execute: (input, ctx) => make(ctx, "edit", input),
    });

    rl.registerAction("models", {
      access: "read",
      description:
        "List the image models create and edit can use, with what each can do and the model each action uses by default.",
      hints: { openWorld: true },
      inputSchema: t.Object(
        {
          query: t.Optional(
            t.String({
              minLength: 1,
              description:
                "Words to find models by, such as flux or vector. Without it, the list is the provider's own, or its best-known models when it has thousands",
            }),
          ),
          limit: t.Optional(
            t.Integer({
              minimum: 1,
              maximum: MAX_LISTED,
              description: `The most models to return, from 1 to ${MAX_LISTED}. The default is ${DEFAULT_LISTED}`,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      outputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          createModel: { type: "string" },
          editModel: { type: "string" },
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                create: { type: "boolean" },
                edit: { type: "boolean" },
              },
              required: ["id", "create", "edit"],
            },
          },
        },
        required: ["provider", "models"],
      },
      async execute(input, ctx) {
        const { config } = ctx.connection;
        const provider = chosen(providers, config, !ctx.credentials);
        const words = input.query?.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = (model: ImageModel) =>
          !words ||
          words.every((word) =>
            `${model.id} ${model.name ?? ""} ${model.description ?? ""}`
              .toLowerCase()
              .includes(word),
          );
        const known = (await modelsOf(ctx, provider)).models.filter(matches);
        // A provider with thousands of models is searched for what its list does not hold.
        const searched =
          input.query && provider.findModel
            ? await provider.listModels?.(apiOf(ctx, provider), input.query)
            : [];
        const byId = new Map(
          [...(searched ?? []), ...known].map((model) => [model.id, model]),
        );
        const createModel = defaultModel(provider, config, "create");
        const editModel = defaultModel(provider, config, "edit");
        return {
          provider: provider.name,
          ...(createModel ? { createModel } : {}),
          ...(editModel ? { editModel } : {}),
          models: [...byId.values()]
            .slice(0, input.limit ?? DEFAULT_LISTED)
            .map(described),
        };
      },
    });
  };
}

export default imagegen();
