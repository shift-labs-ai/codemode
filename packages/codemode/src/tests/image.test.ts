import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  imageBase64,
  imageDataUrl,
  imageFacts,
  readLocalImage,
} from "../utils/image.js";
import { png } from "./helpers/image.js";

const dir = mkdtempSync(join(tmpdir(), "image-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("imageFacts", () => {
  it("tells an image's type and size from its first bytes", () => {
    assert.deepEqual(imageFacts(png(640, 480)), {
      mimeType: "image/png",
      width: 640,
      height: 480,
    });
    const gif = Buffer.alloc(16);
    gif.write("GIF89a");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    assert.deepEqual(imageFacts(gif), {
      mimeType: "image/gif",
      width: 320,
      height: 200,
    });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x00, 0x00,
    ]);
    assert.deepEqual(imageFacts(jpeg), {
      mimeType: "image/jpeg",
      width: 640,
      height: 480,
    });
    const webp = Buffer.alloc(30);
    webp.write("RIFF");
    webp.write("WEBP", 8);
    webp.write("VP8X", 12);
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    assert.deepEqual(imageFacts(webp), {
      mimeType: "image/webp",
      width: 800,
      height: 600,
    });
    assert.deepEqual(
      imageFacts(
        Buffer.from(
          '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
      ),
      { mimeType: "image/svg+xml" },
    );
    assert.equal(imageFacts(Buffer.from("plain text, long enough")), undefined);
  });
});

describe("an image's bytes for an API", () => {
  it("are base64, or a data URL with the image's type", () => {
    const image = { bytes: new Uint8Array([0]), mimeType: "image/png" };
    assert.equal(imageBase64(image), "AA==");
    assert.equal(imageDataUrl(image), "data:image/png;base64,AA==");
  });
});

describe("readLocalImage", () => {
  const options = {
    subject: "example: photo",
    maxBytes: 1024 * 1024,
    types: ["image/png", "image/jpeg"],
  };

  it("reads an image with what its bytes say it is", async () => {
    const file = join(dir, "photo.jpg");
    writeFileSync(file, png(640, 480));
    const image = await readLocalImage(file, options);
    assert.deepEqual(
      { ...image, bytes: image.bytes.byteLength },
      {
        mimeType: "image/png",
        width: 640,
        height: 480,
        bytes: 33,
        fileName: "photo.jpg",
      },
    );
  });

  it("refuses a file that is none of the types, whatever its name, and one too large", async () => {
    const text = join(dir, "notes.png");
    writeFileSync(text, "not an image");
    await assert.rejects(() => readLocalImage(text, options), {
      message: "example: photo is not a PNG or JPEG image.",
    });
    const svg = join(dir, "logo.svg");
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await assert.rejects(
      () =>
        readLocalImage(svg, {
          ...options,
          types: ["image/png", "image/jpeg", "image/webp"],
        }),
      { message: "example: photo is not a PNG, JPEG or WebP image." },
    );
    const big = join(dir, "big.png");
    writeFileSync(big, Buffer.concat([png(10, 10), Buffer.alloc(40)]));
    await assert.rejects(
      () => readLocalImage(big, { ...options, maxBytes: 64 }),
      { message: /^example: photo is larger than / },
    );
  });
});
