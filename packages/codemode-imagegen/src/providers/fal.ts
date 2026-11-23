import { pathSegments } from "@shiftlabs/codemode";
import { inputFor } from "../schema.js";
import type { ImageModel, ImageProvider, ProviderApi } from "../types.js";
import { describedModel, finished, hostedModel } from "./hosted.js";

/** fal's categories for the two things this package does. */
const CATEGORIES = ["text-to-image", "image-to-image"];
/** Every queue request declares a JSON body, the bodyless ones too. */
const JSON_BODY = { "Content-Type": "application/json" };

interface Listed {
  endpoint_id?: string;
  metadata?: { display_name?: string; description?: string; category?: string };
  openapi?: { components?: { schemas?: Record<string, unknown> } };
}

function listed({ endpoint_id, metadata }: Listed): ImageModel[] {
  return endpoint_id && CATEGORIES.includes(metadata?.category ?? "")
    ? [
        {
          id: endpoint_id,
          ...(metadata?.display_name ? { name: metadata.display_name } : {}),
          ...(metadata?.description
            ? { description: metadata.description }
            : {}),
          create: metadata?.category === "text-to-image",
          edit: metadata?.category === "image-to-image",
        },
      ]
    : [];
}

/** Where requests are queued, and what the addresses a queued request answers are beneath. */
const QUEUE = "https://queue.fal.run/";

/**
 * The path of an address fal answered for a queued request. fal asks about a
 * request under the model's application, not its whole id, and says where.
 */
function queuePath(url: string | undefined): string {
  if (!url?.startsWith(QUEUE))
    throw new Error("fal answered no address to ask about the request at.");
  return pathSegments(url.slice(QUEUE.length));
}

async function findModel(api: ProviderApi, id: string) {
  const { models } = await api.request<{ models?: Listed[] }>({
    target: "falCatalog",
    path: "models",
    query: { endpoint_id: id, expand: "openapi-3.0" },
  });
  const found = models?.find((model) => model.endpoint_id === id);
  if (!found || !listed(found).length) return undefined;
  const schemas = found.openapi?.components?.schemas ?? {};
  const input = Object.entries(schemas).find(([name]) =>
    name.endsWith("Input"),
  );
  return hostedModel(listed(found)[0], input?.[1], schemas);
}

export const fal: ImageProvider = {
  name: "fal",
  env: "FAL_KEY",
  key: { header: "Authorization", prefix: "Key " },
  targets: {
    fal: { baseUrl: QUEUE, methods: ["GET", "POST"] },
    falCatalog: { baseUrl: "https://api.fal.ai/v1/", methods: ["GET"] },
  },
  downloads: ["fal.media"],
  defaults: { create: "fal-ai/flux/schnell", edit: "fal-ai/flux-pro/kontext" },
  models: [
    {
      id: "fal-ai/flux/schnell",
      name: "FLUX.1 [schnell]",
      create: true,
      edit: false,
    },
    {
      id: "fal-ai/flux-pro/kontext",
      name: "FLUX.1 Kontext [pro]",
      create: false,
      edit: true,
    },
  ],
  // fal hosts thousands of models, so a list is the first of each category, or those a query finds.
  async listModels(api, query) {
    const pages = await Promise.all(
      CATEGORIES.map((category) =>
        api.request<{ models?: Listed[] }>({
          target: "falCatalog",
          path: "models",
          query: { category, status: "active", limit: 50, q: query },
        }),
      ),
    );
    return pages.flatMap((page) => (page.models ?? []).flatMap(listed));
  },
  findModel,
  async generate(api, request) {
    const { id } = request.model;
    const { fields } = await describedModel(request.model, (found) =>
      findModel(api, found),
    );
    const queued = await api.request<{
      request_id?: string;
      status_url?: string;
      response_url?: string;
    }>({
      path: pathSegments(id),
      method: "POST",
      headers: JSON_BODY,
      body: new TextEncoder().encode(JSON.stringify(inputFor(fields, request))),
    });
    const { request_id } = queued;
    if (!request_id) throw new Error("fal answered no request id.");
    const status = queuePath(queued.status_url);
    const result = queuePath(queued.response_url);
    await finished(api, `fal request ${request_id}`, async () => {
      const state = await api.request<{ status?: string; error?: unknown }>({
        path: status,
        headers: JSON_BODY,
      });
      if (state.status !== "COMPLETED") return undefined;
      if (state.error) throw new Error(`fal request ${request_id} failed.`);
      return true;
    });
    const output = await api.request<{
      images?: Array<{ url?: string }>;
      image?: { url?: string };
    }>({ path: result, headers: JSON_BODY });
    return [...(output.images ?? []), output.image ?? {}].flatMap(({ url }) =>
      url ? [{ url }] : [],
    );
  },
};
