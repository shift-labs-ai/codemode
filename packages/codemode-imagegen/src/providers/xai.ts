import { imageDataUrl } from "@shiftlabs/codemode";
import { nearestRatio, type Size } from "../size.js";
import type { ImageProvider } from "../types.js";
import { type ImagesAnswer, imagesOf } from "./answer.js";

/** The aspect ratios xAI's image models take. */
const RATIOS = [
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "2:3",
  "3:2",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
  "21:9",
  "5:2",
];

/** The resolution tier whose longer side is closest above the one asked for. */
function resolutionFor({ width, height }: Size): string {
  const longer = Math.max(width, height);
  return longer <= 1024 ? "1k" : longer <= 1536 ? "1.5k" : "2k";
}

interface Listed {
  models?: Array<{ id?: string; input_modalities?: string[] }>;
}

export const xai: ImageProvider = {
  name: "xai",
  env: "XAI_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  targets: {
    xai: { baseUrl: "https://api.x.ai/v1/", methods: ["GET", "POST"] },
  },
  defaults: {
    create: "grok-imagine-image-2.0",
    edit: "grok-imagine-image-2.0",
  },
  models: [{ id: "grok-imagine-image-2.0", create: true, edit: true }],
  async listModels(api) {
    const { models } = await api.request<Listed>({
      path: "image-generation-models",
    });
    return (models ?? []).flatMap(({ id, input_modalities }) =>
      id
        ? [
            {
              id,
              create: true,
              edit: (input_modalities ?? []).includes("image"),
            },
          ]
        : [],
    );
  },
  async generate(api, { prompt, model, numImages, size, images }) {
    const sources = images.map((image) => ({ url: imageDataUrl(image) }));
    const answer = await api.request<ImagesAnswer>({
      path: images.length ? "images/edits" : "images/generations",
      method: "POST",
      json: {
        model: model.id,
        prompt,
        n: numImages,
        response_format: "b64_json",
        ...(size
          ? {
              aspect_ratio: nearestRatio(size, RATIOS),
              resolution: resolutionFor(size),
            }
          : {}),
        ...(sources.length === 1 ? { image: sources[0] } : {}),
        ...(sources.length > 1 ? { images: sources } : {}),
      },
    });
    return imagesOf(answer);
  },
};
