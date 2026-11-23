import {
  type LocalImage,
  multipartBody,
  pathSegment,
  pathSegments,
} from "@shiftlabs/codemode";
import { inputFor } from "../schema.js";
import type { ImageModel, ImageProvider, ProviderApi } from "../types.js";
import { describedModel, finished, hostedModel } from "./hosted.js";

/** Replicate's collections for the two things this package does. */
const COLLECTIONS = [
  { slug: "text-to-image", create: true, edit: false },
  { slug: "image-editing", create: false, edit: true },
];

interface Listed {
  owner?: string;
  name?: string;
  description?: string;
  latest_version?: {
    id?: string;
    openapi_schema?: { components?: { schemas?: Record<string, unknown> } };
  };
}

/** The states a prediction ends in without an output. */
const ENDED = ["failed", "canceled", "aborted"];

interface Prediction {
  id?: string;
  status?: string;
  output?: unknown;
}

/** A model a search found, with the tags that say what it does. */
interface Found {
  model?: Listed;
  metadata?: { tags?: string[] };
}

const idOf = ({ owner, name }: Listed) =>
  owner && name ? `${owner}/${name}` : "";

function listed(
  model: Listed,
  can: { create: boolean; edit: boolean },
): ImageModel[] {
  return idOf(model)
    ? [
        {
          id: idOf(model),
          ...(model.description ? { description: model.description } : {}),
          ...can,
        },
      ]
    : [];
}

/** Upload an image to edit as a file, and answer the address a model reads it from. */
async function uploaded(api: ProviderApi, image: LocalImage): Promise<string> {
  const form = new FormData();
  form.append(
    "content",
    new Blob([image.bytes], { type: image.mimeType }),
    image.fileName,
  );
  const { body, contentType } = await multipartBody(form);
  const file = await api.request<{ urls?: { get?: string } }>({
    path: "files",
    method: "POST",
    body,
    headers: { "Content-Type": contentType },
  });
  if (!file.urls?.get)
    throw new Error("replicate answered no address for an uploaded image.");
  return file.urls.get;
}

async function findModel(api: ProviderApi, id: string) {
  const model = await api.request<Listed>({
    path: `models/${pathSegments(id)}`,
  });
  const schemas =
    model.latest_version?.openapi_schema?.components?.schemas ?? {};
  return hostedModel(
    {
      id,
      description: model.description,
      version: model.latest_version?.id,
    },
    schemas.Input,
    schemas,
  );
}

export const replicate: ImageProvider = {
  name: "replicate",
  env: "REPLICATE_API_TOKEN",
  key: { header: "Authorization", prefix: "Bearer " },
  targets: {
    replicate: {
      baseUrl: "https://api.replicate.com/v1/",
      methods: ["GET", "POST"],
      allowedHeaders: ["Prefer"],
    },
  },
  downloads: ["replicate.delivery"],
  defaults: {
    create: "black-forest-labs/flux-schnell",
    edit: "black-forest-labs/flux-kontext-pro",
  },
  models: [
    { id: "black-forest-labs/flux-schnell", create: true, edit: false },
    { id: "black-forest-labs/flux-kontext-pro", create: false, edit: true },
  ],
  // Replicate hosts thousands of models, so a list is its two image collections, or what a search finds.
  async listModels(api, query) {
    if (query) {
      const { models } = await api.request<{ models?: Found[] }>({
        path: "search",
        query: { query, limit: 50 },
      });
      // A search finds models of every kind: its tags say which make images, and how.
      return (models ?? []).flatMap(({ model, metadata }) => {
        const tags = metadata?.tags ?? [];
        const create = tags.includes("text-to-image");
        const edit =
          tags.includes("image-to-image") || tags.includes("image-editing");
        return model && (create || edit) ? listed(model, { create, edit }) : [];
      });
    }
    const collections = await Promise.all(
      COLLECTIONS.map(({ slug }) =>
        api.request<{ models?: Listed[] }>({ path: `collections/${slug}` }),
      ),
    );
    return collections.flatMap((collection, index) =>
      (collection.models ?? []).flatMap((model) =>
        listed(model, COLLECTIONS[index]),
      ),
    );
  },
  findModel,
  async generate(api, request) {
    const { id } = request.model;
    const { fields, version } = await describedModel(request.model, (found) =>
      findModel(api, found),
    );
    const input = await inputFor(fields, request, (image) =>
      uploaded(api, image),
    );
    // The request waits up to a minute for the model, and answers a running job past that.
    let prediction = await api.request<Prediction>({
      path: "predictions",
      method: "POST",
      headers: { Prefer: "wait" },
      json: {
        version: version ? `${id}:${version}` : id,
        input,
      },
    });
    const { id: job } = prediction;
    if (!job) throw new Error("replicate answered no prediction id.");
    let asked = false;
    const output = await finished(
      api,
      `replicate prediction ${job}`,
      async () => {
        if (asked)
          prediction = await api.request<Prediction>({
            path: `predictions/${pathSegment(job)}`,
          });
        asked = true;
        if (prediction.status === "succeeded") return prediction.output ?? null;
        if (ENDED.includes(prediction.status ?? ""))
          throw new Error(`replicate prediction ${job} ${prediction.status}.`);
        return undefined;
      },
    );
    return (Array.isArray(output) ? output : [output]).flatMap((url) =>
      typeof url === "string" ? [{ url }] : [],
    );
  },
};
