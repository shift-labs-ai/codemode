import { multipartBody } from "@shiftlabs/codemode";
import { fitSize, type Size } from "../size.js";
import type { ImageModel, ImageProvider } from "../types.js";
import { type ImagesAnswer, imagesOf } from "./answer.js";

/** A GPT Image model takes any size within these bounds. */
const SIZES = {
  multiple: 16,
  maxSide: 3840,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxRatio: 3,
};

function model(id: string): ImageModel {
  return { id, create: true, edit: true };
}

function sizeFor(size: Size): string {
  const { width, height } = fitSize(size, SIZES);
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
  // The gpt-image-1 line takes other sizes and shuts down on 2026-12-01, so it is left out.
  async listModels(api) {
    const { data } = await api.request<{ data?: Array<{ id?: unknown }> }>({
      path: "models",
    });
    return (data ?? []).flatMap(({ id }) =>
      typeof id === "string" && /^(gpt-image-(?!1)|chatgpt-image-)/.test(id)
        ? [model(id)]
        : [],
    );
  },
  async generate(api, { prompt, model: { id }, numImages, size, images }) {
    const common = {
      model: id,
      prompt,
      n: numImages,
      ...(size ? { size: sizeFor(size) } : {}),
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
