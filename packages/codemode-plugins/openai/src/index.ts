/**
 * OpenAI image generation for codemode.
 *
 * Wraps the GPT Image line: `image.create` at
 * /v1/images/generations, `image.edit` at /v1/images/edits. Generated
 * images are written to disk and the action returns their file `path`s
 * (plus the optional revised prompt) — never raw base64, which bloats the
 * agent context and is stripped before delivery. Hand each `path` to the
 * host's file-sending tool (e.g. send_file) to deliver the image.
 *
 * Quality leader for text rendering and prompt adherence — pair with
 * any other plugin you'd compose images for (storyblok, github,
 * notion, slack uploads, …).
 *
 *   const { images } = await openai.image.create({ prompt: "a red bicycle on snow" })
 *   // images[0].path -> "/tmp/openai-image-….png"
 */

import {
  type CodemodePluginAPI,
  credentialJson,
  multipartBody,
} from "@shiftlabs/codemode";
import {
  mediaDir,
  readImageInput,
  SAVE_DIR_DESCRIPTION,
  SEND_FILE_NOTE,
  writeImageFile,
} from "../../_shared/mediaFile.js";
import { openaiCredential } from "./credentials.js";

/**
 * The default model; override per call or via the connection.
 *
 * Each GPT Image line from 2.5 ships as two models: Flare, the faster one,
 * and Sunburst, for detailed work and precise edits. Pin an earlier model
 * via `defaultModel` to stay on it.
 */
const DEFAULT_MODEL = "gpt-image-2.6-flare";

/** The models the inputs name. The API takes any GPT Image model the key reaches. */
const MODELS =
  "gpt-image-2.6-flare | gpt-image-2.6-sunburst | gpt-image-2.5-flare | gpt-image-2.5-sunburst | gpt-image-2";

/**
 * The size contract, shared by create and edit so the two cannot drift apart.
 *
 * All four constraints bind together: the total-pixel floor is the one that
 * surprises, because 512x512 satisfies every other rule and still 400s.
 */
const SIZE_RULE =
  "Any WIDTHxHEIGHT with both sides multiples of 16, aspect between 1:3 and 3:1, " +
  "no edge over 3840, and a total between 655,360 and 8,294,400 pixels — so 512x512 is too small and 1536x864 is fine; " +
  "above 2560x1440 is experimental. 1024x1024 | 1536x1024 | 1024x1536 work on every model.";

/** Quality tiers, likewise shared. `auto` is the API's default. */
const QUALITY_RULE =
  "low | medium | high | auto, plus xhigh | max on gpt-image-2.5-*";

/**
 * Model precedence, shared by create and edit: the call wins, then the
 * connection's `defaultModel` (or OPENAI_IMAGE_MODEL), then
 * `DEFAULT_MODEL`.
 */
function resolveModel(
  explicit: string | undefined,
  config: Record<string, unknown>,
): string {
  return (
    explicit ?? (config.defaultModel as string | undefined) ?? DEFAULT_MODEL
  );
}

interface CreateInput {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  saveDir?: string;
}

interface EditInput {
  prompt: string;
  imagePath?: string;
  imagePaths?: string[];
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  saveDir?: string;
}

interface OpenAIImage {
  b64_json: string;
  revised_prompt?: string;
}

export default function openai(rl: CodemodePluginAPI) {
  rl.setName("openai");
  rl.setVersion("0.1.0");
  rl.setCredential(openaiCredential);

  rl.setConnectionSchema({
    apiKey: {
      type: "string",
      required: true,
      description: "OpenAI API key",
      env: "OPENAI_API_KEY",
    },
    defaultModel: {
      type: "string",
      required: false,
      description: `Default image model when a call omits \`model\` — e.g. gpt-image-2 to pin an earlier line. Defaults to ${DEFAULT_MODEL}.`,
      env: "OPENAI_IMAGE_MODEL",
    },
  });

  rl.registerAction("image.create", {
    access: "write",
    description:
      "Generate an image with OpenAI (GPT Image). Writes the PNG(s) to disk and returns their file `path`s (plus any revised prompt) — not base64. Deliver each image to the user with send_file using its `path`.",
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
        description: `${MODELS}. Omit to use the connection default.`,
      },
      size: {
        type: "string",
        required: false,
        description: `WxH (default: 1024x1024) or auto. ${SIZE_RULE}`,
      },
      quality: {
        type: "string",
        required: false,
        description: QUALITY_RULE,
      },
      n: {
        type: "number",
        required: false,
        description: "Number of images (default: 1, max: 4)",
      },
    },
    async execute(input, ctx) {
      const p = (input ?? {}) as CreateInput;
      if (typeof p.prompt !== "string" || p.prompt.length === 0) {
        throw new Error("openai: prompt is required");
      }

      const model = resolveModel(p.model, ctx.connection.config);

      const body: Record<string, unknown> = {
        model,
        prompt: p.prompt,
        n: Math.min(p.n ?? 1, 4),
        size: p.size ?? "1024x1024",
        output_format: "png",
      };
      if (p.quality) body.quality = p.quality;

      const data = (await credentialJson(ctx, openaiCredential, "openai", {
        target: "api",
        path: "generations",
        method: "POST",
        json: body,
      })) as { data?: OpenAIImage[] };
      const stamp = Date.now();
      const images = (data.data ?? []).map((d, i) => ({
        ...writeImageFile({
          base64: d.b64_json,
          provider: "openai-image",
          index: i,
          saveDir: mediaDir(p.saveDir, ctx),
          stamp,
        }),
        ...(d.revised_prompt ? { revisedPrompt: d.revised_prompt } : {}),
      }));
      return { provider: "openai", model, images, note: SEND_FILE_NOTE };
    },
  });

  rl.registerAction("image.edit", {
    access: "write",
    description:
      "Edit a local image with OpenAI (gpt-image-*) via /v1/images/edits: give the file path(s) and describe the change. Writes the edited PNG(s) to disk and returns their file `path`s — not base64. Deliver each with send_file using its `path`.",
    inputSchema: {
      prompt: {
        type: "string",
        required: true,
        description: "Instruction describing the edit to apply",
      },
      imagePath: {
        type: "string",
        required: false,
        description:
          "Path to the source image file. Either this or imagePaths is required.",
      },
      imagePaths: {
        type: "array",
        required: false,
        description:
          "Paths to multiple source images (gpt-image models accept up to 16; the first is the primary).",
      },
      saveDir: {
        type: "string",
        required: false,
        description: SAVE_DIR_DESCRIPTION,
      },
      model: {
        type: "string",
        required: false,
        description: `${MODELS}. Omit to use the connection default.`,
      },
      size: {
        type: "string",
        required: false,
        description: `WxH output size. Omit to let the API match the input. ${SIZE_RULE}`,
      },
      quality: {
        type: "string",
        required: false,
        description: QUALITY_RULE,
      },
      n: {
        type: "number",
        required: false,
        description: "Number of edited variants (default: 1, max: 4)",
      },
    },
    async execute(input, ctx) {
      const p = (input ?? {}) as EditInput;
      if (typeof p.prompt !== "string" || p.prompt.length === 0) {
        throw new Error("openai: prompt is required");
      }
      const paths =
        Array.isArray(p.imagePaths) && p.imagePaths.length > 0
          ? p.imagePaths
          : p.imagePath
            ? [p.imagePath]
            : [];
      if (paths.length === 0) {
        throw new Error("openai: imagePath (or imagePaths) is required");
      }

      const model = resolveModel(p.model, ctx.connection.config);

      const form = new FormData();
      form.append("model", model);
      form.append("prompt", p.prompt);
      form.append("n", String(Math.min(p.n ?? 1, 4)));
      if (p.size) form.append("size", p.size);
      if (p.quality) form.append("quality", p.quality);
      for (const path of paths) {
        const img = await readImageInput(path, "openai");
        form.append(
          "image[]",
          new Blob([img.bytes], { type: img.mimeType }),
          img.fileName,
        );
      }

      const { body: formBytes, contentType } = await multipartBody(form);
      const data = (await credentialJson(ctx, openaiCredential, "openai", {
        target: "api",
        path: "edits",
        method: "POST",
        body: formBytes,
        headers: { "Content-Type": contentType },
      })) as { data?: OpenAIImage[] };
      const stamp = Date.now();
      const images = (data.data ?? []).map((d, i) => ({
        ...writeImageFile({
          base64: d.b64_json,
          provider: "openai-image",
          index: i,
          saveDir: mediaDir(p.saveDir, ctx),
          stamp,
        }),
        ...(d.revised_prompt ? { revisedPrompt: d.revised_prompt } : {}),
      }));
      return { provider: "openai", model, images, note: SEND_FILE_NOTE };
    },
  });
}
