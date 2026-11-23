import { pathSegment } from "@shiftlabs/codemode";
import { base64Of } from "../image.js";
import { nearestRatio } from "../size.js";
import type { ImageModel, ImageProvider } from "../types.js";

/** The aspect ratios every Gemini image model takes. */
const RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

interface Listed {
  models?: Array<{
    name?: string;
    displayName?: string;
    description?: string;
    supportedGenerationMethods?: string[];
  }>;
}

interface Answer {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string } }> };
  }>;
}

const model = (id: string, name?: string): ImageModel => ({
  id,
  ...(name ? { name } : {}),
  create: true,
  edit: true,
});

export const google: ImageProvider = {
  name: "google",
  env: "GOOGLE_API_KEY",
  key: { query: "key" },
  targets: {
    google: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
      methods: ["GET", "POST"],
    },
  },
  defaults: {
    create: "gemini-2.5-flash-image",
    edit: "gemini-2.5-flash-image",
  },
  models: [
    model("gemini-2.5-flash-image", "Nano Banana"),
    model("gemini-3.1-flash-image", "Nano Banana 2"),
    model("gemini-3.1-flash-lite-image", "Nano Banana 2 Lite"),
    model("gemini-3-pro-image", "Nano Banana Pro"),
    model("gemini-nano-banana-2.1", "Nano Banana 2.1"),
  ],
  // The list is of every Gemini model, so the image ones are told by their names.
  async listModels(api) {
    const { models } = await api.request<Listed>({
      path: "models",
      query: { pageSize: 1000 },
    });
    return (models ?? []).flatMap((listed) => {
      const id = listed.name?.replace(/^models\//, "") ?? "";
      return /image|banana/.test(id) &&
        listed.supportedGenerationMethods?.includes("generateContent")
        ? [
            {
              ...model(id, listed.displayName),
              ...(listed.description
                ? { description: listed.description }
                : {}),
            },
          ]
        : [];
    });
  },
  // A request answers one image, so several images are several requests.
  async generate(api, { prompt, model: { id }, numImages, size, images }) {
    const one = () =>
      api.request<Answer>({
        path: `models/${pathSegment(id)}:generateContent`,
        method: "POST",
        json: {
          contents: [
            {
              parts: [
                { text: prompt },
                ...images.map((image) => ({
                  inlineData: {
                    mimeType: image.mimeType,
                    data: base64Of(image),
                  },
                })),
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"],
            ...(size
              ? { imageConfig: { aspectRatio: nearestRatio(size, RATIOS) } }
              : {}),
          },
        },
      });
    const answers = await Promise.all(Array.from({ length: numImages }, one));
    return answers.flatMap((answer) =>
      (answer.candidates ?? []).flatMap((candidate) =>
        (candidate.content?.parts ?? []).flatMap((part) =>
          part.inlineData?.data ? [{ base64: part.inlineData.data }] : [],
        ),
      ),
    );
  },
};
