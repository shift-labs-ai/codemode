import { dataUrlOf } from "../image.js";
import { nearestRatio } from "../size.js";
import type { ImageModel, ImageProvider } from "../types.js";
import { type ImagesAnswer, imagesOf } from "./answer.js";

/** The shapes every Recraft model takes, as `w:h`. */
const RATIOS = [
  "1:1",
  "2:1",
  "1:2",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "5:4",
  "4:5",
  "6:10",
  "14:10",
  "10:14",
  "16:9",
  "9:16",
];
/** How far an edit departs from its image, from 0 to 1. Recraft requires one; this keeps the image recognisable. */
const EDIT_STRENGTH = 0.2;

/** Every line edits an image except V2 and the Flash model. */
const model = (id: string): ImageModel => ({
  id,
  create: true,
  edit: !/^recraftv2|flash/.test(id),
});

export const recraft: ImageProvider = {
  name: "recraft",
  env: "RECRAFT_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  targets: {
    recraft: {
      baseUrl: "https://external.api.recraft.ai/v1/",
      methods: ["POST"],
    },
  },
  defaults: { create: "recraftv4_1", edit: "recraftv4_1" },
  // Recraft's API lists no models, so these are the ones its reference names.
  models: [
    "recraftv4_1",
    "recraftv4_1_pro",
    "recraftv4_1_vector",
    "recraftv4_1_pro_vector",
    "recraftv4_1_flash_v2",
    "recraftv4_1_utility",
    "recraftv4_1_utility_pro",
    "recraftv4_1_utility_vector",
    "recraftv4_1_utility_pro_vector",
    "recraftv4",
    "recraftv4_pro",
    "recraftv4_vector",
    "recraftv4_pro_vector",
    "recraftv3",
    "recraftv3_vector",
    "recraftv2",
    "recraftv2_vector",
  ].map(model),
  async generate(api, { prompt, model: { id }, numImages, size, images }) {
    if (images.length > 1)
      throw new Error("recraft edits one image. Pass one path in images.");
    if (images.length && size)
      throw new Error(
        "recraft keeps the size of the image it edits. Leave width and height out.",
      );
    const common = {
      prompt,
      model: id,
      n: numImages,
      response_format: "b64_json",
    };
    const answer = await api.request<ImagesAnswer>(
      images.length
        ? {
            path: "images/imageToImage",
            method: "POST",
            json: {
              ...common,
              image_url: dataUrlOf(images[0]),
              strength: EDIT_STRENGTH,
            },
          }
        : {
            path: "images/generations",
            method: "POST",
            json: {
              ...common,
              ...(size ? { size: nearestRatio(size, RATIOS) } : {}),
            },
          },
    );
    return imagesOf(answer);
  },
};
