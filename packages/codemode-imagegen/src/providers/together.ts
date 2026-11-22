import { dataUrlOf } from "../image.js";
import { fitSize } from "../size.js";
import type { ImageModel, ImageProvider } from "../types.js";
import { type ImagesAnswer, imagesOf } from "./answer.js";

/** Together's image models take sides that are multiples of 16, within these bounds. */
const SIZES = {
  multiple: 16,
  maxSide: 2048,
  minPixels: 65_536,
  maxPixels: 4_194_304,
};

/** Whether a model takes images to edit: the Kontext and FLUX.2 lines, and Google's. */
const edits = (id: string) => /kontext|FLUX\.2|flash-image|gemini/i.test(id);
/** The Kontext line takes its one image as `image_url`; the others take a list. */
const takesOneImage = (id: string) => /kontext/i.test(id);

const model = (id: string, name?: string): ImageModel => ({
  id,
  ...(name ? { name } : {}),
  create: true,
  edit: edits(id),
});

interface Listed {
  id?: string;
  display_name?: string;
  type?: string;
}

export const together: ImageProvider = {
  name: "together",
  env: "TOGETHER_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  targets: {
    together: {
      baseUrl: "https://api.together.xyz/v1/",
      methods: ["GET", "POST"],
    },
  },
  defaults: {
    create: "black-forest-labs/FLUX.1-schnell",
    edit: "black-forest-labs/FLUX.1-kontext-pro",
  },
  models: [
    "black-forest-labs/FLUX.1-schnell",
    "black-forest-labs/FLUX.1.1-pro",
    "black-forest-labs/FLUX.1-kontext-pro",
    "black-forest-labs/FLUX.1-kontext-max",
    "black-forest-labs/FLUX.2-pro",
    "black-forest-labs/FLUX.2-dev",
    "black-forest-labs/FLUX.2-flex",
    "black-forest-labs/FLUX.2-max",
    "google/flash-image-2.5",
    "google/gemini-3-pro-image",
  ].map((id) => model(id)),
  async listModels(api) {
    const answer = await api.request<Listed[] | { data?: Listed[] }>({
      path: "models",
    });
    return (Array.isArray(answer) ? answer : (answer.data ?? [])).flatMap(
      ({ id, display_name, type }) =>
        id && type === "image" ? [model(id, display_name)] : [],
    );
  },
  async generate(api, { prompt, model: { id }, numImages, size, images }) {
    if (takesOneImage(id) && images.length > 1)
      throw new Error(`${id} takes one image. Pass one path in images.`);
    const urls = images.map(dataUrlOf);
    const answer = await api.request<ImagesAnswer>({
      path: "images/generations",
      method: "POST",
      json: {
        model: id,
        prompt,
        n: numImages,
        response_format: "base64",
        ...(size ? fitSize(size, SIZES) : {}),
        ...(urls.length
          ? takesOneImage(id)
            ? { image_url: urls[0] }
            : { reference_images: urls }
          : {}),
      },
    });
    return imagesOf(answer);
  },
};
