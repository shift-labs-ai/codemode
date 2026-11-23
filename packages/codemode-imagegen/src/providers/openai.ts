import { multipartBody } from "@shiftlabs/codemode";
import { fitSize, nearestSize, type Size } from "../size.js";
import type { ImageModel, ImageProvider } from "../types.js";
import { type ImagesAnswer, imagesOf } from "./answer.js";

/** The sizes the GPT Image 1 line takes. */
const FIXED_SIZES: Size[] = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];
/** What gpt-image-2 and later take: any size within these bounds. */
const FREE_SIZES = {
  multiple: 16,
  maxSide: 3840,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxRatio: 3,
};

const takesFixedSizes = (id: string) => id.startsWith("gpt-image-1");

function model(id: string): ImageModel {
  return { id, create: true, edit: true };
}

function sizeFor(id: string, size: Size): string {
  const { width, height } = takesFixedSizes(id)
    ? nearestSize(size, FIXED_SIZES)
    : fitSize(size, FREE_SIZES);
  return `${width}x${height}`;
}

export const openai: ImageProvider = {
  name: "openai",
  env: "OPENAI_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  targets: {
    openai: { baseUrl: "https://api.openai.com/v1/", methods: ["GET", "POST"] },
  },
  defaults: { create: "gpt-image-2.6-flare", edit: "gpt-image-2.6-flare" },
  models: [
    "gpt-image-2.6-flare",
    "gpt-image-2.6-sunburst",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2",
  ].map(model),
  // The list is of every model the key reaches, of any kind, so the image ones are told by their names.
  async listModels(api) {
    const { data } = await api.request<{ data?: Array<{ id?: unknown }> }>({
      path: "models",
    });
    return (data ?? []).flatMap(({ id }) =>
      typeof id === "string" && /^(gpt-image-|chatgpt-image-)/.test(id)
        ? [model(id)]
        : [],
    );
  },
  async generate(api, { prompt, model: { id }, numImages, size, images }) {
    const common = {
      model: id,
      prompt,
      n: numImages,
      ...(size ? { size: sizeFor(id, size) } : {}),
    };
    let answer: ImagesAnswer;
    if (images.length) {
      const form = new FormData();
      for (const [name, value] of Object.entries(common))
        form.append(name, String(value));
      for (const image of images)
        form.append(
          "image[]",
          new Blob([image.bytes], { type: image.mimeType }),
          image.fileName,
        );
      const { body, contentType } = await multipartBody(form);
      answer = await api.request({
        path: "images/edits",
        method: "POST",
        body,
        headers: { "Content-Type": contentType },
      });
    } else
      answer = await api.request({
        path: "images/generations",
        method: "POST",
        json: { ...common, output_format: "png" },
      });
    return imagesOf(answer);
  },
};
