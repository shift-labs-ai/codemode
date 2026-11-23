/**
 * What an image is, read from its first bytes: its type, and its size in
 * pixels where the format states one. And an image file an action input
 * names, read as what its bytes say it is.
 */

import { basename } from "node:path";
import { readLocalFile } from "./local-file.js";

export interface ImageFacts {
  mimeType: string;
  width?: number;
  height?: number;
}

/** The file extension of each type of image `imageFacts` tells. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

/** What each type is called in an error. */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "image/svg+xml": "SVG",
};

/** An image's bytes in base64, for an API that takes them in JSON. */
export function imageBase64(image: { bytes: Uint8Array }): string {
  return Buffer.from(image.bytes).toString("base64");
}

/** An image as a `data:` URL, for an API that takes a link or one of these. */
export function imageDataUrl(image: {
  bytes: Uint8Array;
  mimeType: string;
}): string {
  return `data:${image.mimeType};base64,${imageBase64(image)}`;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    // A start-of-frame segment holds the size; C4, C8 and CC are tables, not frames.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
}

function webpSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const u24 = (at: number) =>
      view.getUint16(at, true) | (bytes[at + 2] << 16);
    return { width: 1 + u24(24), height: 1 + u24(27) };
  }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ")
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  return undefined;
}

/** The type and size of an image, or nothing when the bytes are none of the types in `IMAGE_EXTENSIONS`. */
export function imageFacts(bytes: Uint8Array): ImageFacts | undefined {
  if (bytes.length < 12) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 1, 3) === "PNG" && bytes.length >= 24)
    return {
      mimeType: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  if (bytes[0] === 0xff && bytes[1] === 0xd8)
    return { mimeType: "image/jpeg", ...jpegSize(bytes) };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return { mimeType: "image/webp", ...webpSize(bytes) };
  if (ascii(bytes, 0, 3) === "GIF")
    return {
      mimeType: "image/gif",
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  const start = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart();
  if (start.startsWith("<") && start.includes("<svg"))
    return { mimeType: "image/svg+xml" };
  return undefined;
}

/** An image read from a file on the codemode host. */
export interface LocalImage extends ImageFacts {
  bytes: Buffer<ArrayBuffer>;
  fileName: string;
}

/**
 * Read an image file an action input names. What it is, its bytes say, never
 * its name: a file that is none of `types` is refused. `subject` is what
 * errors call the file.
 */
export async function readLocalImage(
  path: string,
  options: { subject: string; maxBytes: number; types: readonly string[] },
): Promise<LocalImage> {
  const { subject, maxBytes, types } = options;
  const bytes = await readLocalFile(path, {
    subject,
    maxBytes,
    oversize: `${subject} is larger than ${maxBytes / (1024 * 1024)} MiB`,
  });
  const facts = imageFacts(bytes);
  if (!facts || !types.includes(facts.mimeType)) {
    const names = types.map((type) => TYPE_NAMES[type] ?? type);
    throw new Error(
      `${subject} is not a ${[names.slice(0, -1).join(", "), names.at(-1)].filter(Boolean).join(" or ")} image.`,
    );
  }
  return { ...facts, bytes, fileName: basename(path) };
}
