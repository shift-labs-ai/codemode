/**
 * Recraft image generation for codemode.
 *
 *   await recraft.image.create({ prompt: "minimalist line-art coffee cup" })
 *   await recraft.image.create({
 *     prompt: "rocket logo, flat vector",
 *     model: "recraftv3_vector",   // → SVG
 *     style: "Vector art",
 *   })
 *
 * Recraft is the design-oriented provider: vector output, brand-
 * consistent style libraries, typography-aware. The default model is
 * Recraft V4.1. Only V2 and V3 models take a curated `style`; a V4 or V4.1
 * model takes a `styleId` of your own instead.
 */

import {
  type CodemodePluginAPI,
  credentialJson,
  multipartBody,
} from "@shiftlabs/codemode";
import {
  IMAGE_TYPES,
  mediaDir,
  readImageInput,
  SAVE_DIR_DESCRIPTION,
  SEND_FILE_NOTE,
  writeImageFile,
} from "../../_shared/mediaFile.js";
import { recraftCredential } from "./credentials.js";

/** The model Recraft's API itself defaults to, for creating and for editing. */
const MODEL = "recraftv4_1";

/** Recraft edits a vector image as well as a raster one. */
const EDIT_TYPES = [...IMAGE_TYPES, "image/svg+xml"];

interface CreateInput {
  prompt: string;
  model?: string;
  style?: string;
  styleId?: string;
  size?: string;
  n?: number;
  saveDir?: string;
}

interface RecraftImage {
  b64_json: string;
}

interface EditInput {
  prompt: string;
  imagePath: string;
  strength?: number;
  model?: string;
  style?: string;
  styleId?: string;
  n?: number;
  saveDir?: string;
}

export default function recraft(rl: CodemodePluginAPI) {
  rl.setName("recraft");
  rl.setVersion("0.1.0");
  rl.setCredential(recraftCredential);

  rl.setConnectionSchema({
    apiKey: {
      type: "string",
      required: true,
      description: "Recraft API key",
      env: "RECRAFT_API_KEY",
    },
  });

  rl.registerAction("image.create", {
    access: "write",
    description:
      "Generate an image with Recraft. Best for design, vector graphics, and brand-consistent work. Writes the image(s) to disk and returns their file `path`s — not base64. Deliver each with send_file using its `path`.",
    inputSchema: {
      prompt: {
        type: "string",
        required: true,
        description: "Detailed description of the image",
      },
      saveDir: {
        type: "string",
        required: false,
        description: SAVE_DIR_DESCRIPTION,
      },
      model: {
        type: "string",
        required: false,
        description: `${MODEL} (default) | recraftv4_1_pro | recraftv4_1_vector | recraftv4_1_pro_vector | recraftv4_1_flash_v2 | recraftv4 | recraftv4_pro | recraftv4_vector | recraftv4_pro_vector | recraftv3 | recraftv3_vector. A _vector model writes SVG.`,
      },
      style: {
        type: "string",
        required: false,
        description:
          "V2/V3 models only — Photorealism | Illustration | Vector art | Hand-drawn | Icon | Recraft V3 Raw",
      },
      styleId: {
        type: "string",
        required: false,
        description: "ID of a custom style created in your Recraft account",
      },
      size: {
        type: "string",
        required: false,
        description:
          "Aspect ratio (1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3 | 2:1 | 1:2) or an exact WxH the model lists; 1024x1024 works on every model. Omit for the model's default.",
      },
      n: {
        type: "number",
        required: false,
        description: "Number of images (default: 1, max: 6)",
      },
    },
    async execute(input, ctx) {
      const p = (input ?? {}) as CreateInput;
      if (typeof p.prompt !== "string" || p.prompt.length === 0) {
        throw new Error("recraft: prompt is required");
      }

      const model = p.model ?? MODEL;

      const body: Record<string, unknown> = {
        prompt: p.prompt,
        model,
        response_format: "b64_json",
        n: Math.min(p.n ?? 1, 6),
      };
      if (p.size) body.size = p.size;
      if (p.style) body.style = p.style;
      if (p.styleId) body.style_id = p.styleId;

      const data = (await credentialJson(ctx, recraftCredential, "recraft", {
        target: "images",
        path: "generations",
        method: "POST",
        json: body,
      })) as { data?: RecraftImage[] };
      const stamp = Date.now();
      const images = (data.data ?? []).map((d, i) =>
        writeImageFile({
          base64: d.b64_json,
          provider: "recraft",
          index: i,
          saveDir: mediaDir(p.saveDir, ctx),
          stamp,
        }),
      );
      return { provider: "recraft", model, images, note: SEND_FILE_NOTE };
    },
  });

  rl.registerAction("image.edit", {
    access: "write",
    description:
      "Edit a local image with Recraft (imageToImage): give the file path, describe the change, and tune `strength` for how far to depart from the original. Writes the edited image(s) to disk and returns their file `path`s — not base64. Deliver each with send_file using its `path`.",
    inputSchema: {
      prompt: {
        type: "string",
        required: true,
        description: "Instruction describing the transformation",
      },
      imagePath: {
        type: "string",
        required: true,
        description:
          "Path to the source image file (PNG, JPG, WEBP, or SVG; under 20 MB, up to 16 MP, sides 256–4096 px)",
      },
      strength: {
        type: "number",
        required: false,
        description:
          "0–1: how strongly to alter the input (default: 0.2 — close to the original)",
      },
      saveDir: {
        type: "string",
        required: false,
        description: SAVE_DIR_DESCRIPTION,
      },
      model: {
        type: "string",
        required: false,
        description: `Any Recraft V3 / V4 / V4.1 model, raster or vector (e.g. recraftv3, recraftv4_pro, recraftv4_1_vector). Default: ${MODEL}.`,
      },
      style: {
        type: "string",
        required: false,
        description:
          "V3 models only — Photorealism | Illustration | Vector art | Hand-drawn | Recraft V3 Raw",
      },
      styleId: {
        type: "string",
        required: false,
        description:
          "V3 models only — ID of a custom style created in your Recraft account",
      },
      n: {
        type: "number",
        required: false,
        description: "Number of edited variants (default: 1, max: 6)",
      },
    },
    async execute(input, ctx) {
      const p = (input ?? {}) as EditInput;
      if (typeof p.prompt !== "string" || p.prompt.length === 0) {
        throw new Error("recraft: prompt is required");
      }
      const img = await readImageInput(p.imagePath, "recraft", EDIT_TYPES);

      const form = new FormData();
      form.append(
        "image",
        new Blob([img.bytes], { type: img.mimeType }),
        img.fileName,
      );
      form.append("prompt", p.prompt);
      form.append("strength", String(p.strength ?? 0.2));
      form.append("response_format", "b64_json");
      form.append("n", String(Math.min(p.n ?? 1, 6)));
      const model = p.model ?? MODEL;
      form.append("model", model);
      if (p.style) form.append("style", p.style);
      if (p.styleId) form.append("style_id", p.styleId);

      const { body, contentType } = await multipartBody(form);
      const data = (await credentialJson(ctx, recraftCredential, "recraft", {
        target: "images",
        path: "imageToImage",
        method: "POST",
        body,
        headers: { "Content-Type": contentType },
      })) as { data?: RecraftImage[] };
      const stamp = Date.now();
      const images = (data.data ?? []).map((d, i) =>
        writeImageFile({
          base64: d.b64_json,
          provider: "recraft",
          index: i,
          saveDir: mediaDir(p.saveDir, ctx),
          stamp,
        }),
      );
      return { provider: "recraft", model, images, note: SEND_FILE_NOTE };
    },
  });
}
