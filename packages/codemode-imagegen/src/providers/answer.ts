import type { ProducedImage } from "../types.js";

/** The answer of an API in OpenAI's shape: each image in base64 under `data`. */
export interface ImagesAnswer {
  data?: Array<{ b64_json?: string }>;
}

/** The images of such an answer. */
export function imagesOf(answer: ImagesAnswer): ProducedImage[] {
  return (answer.data ?? []).flatMap(({ b64_json }) =>
    b64_json ? [{ base64: b64_json }] : [],
  );
}
