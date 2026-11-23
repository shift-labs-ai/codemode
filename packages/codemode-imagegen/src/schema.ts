/**
 * A model's inputs, read from the JSON Schema its host publishes. fal and
 * Replicate host thousands of models that name the same things differently
 * (`num_images` or `num_outputs`, `image_url` or `input_image`); this finds
 * which of a model's fields take the prompt, the count, the size and the
 * images, so one request can be written as that model's input.
 */

import { nearestRatio, nearestSize, parseSize, type Size } from "./size.js";
import type { ImageRequest, SourceImage } from "./types.js";

type Schema = Record<string, unknown>;

/** Where one model takes each part of a request. */
export interface ModelFields {
  prompt: string;
  count?: string;
  /** The field that takes images, and whether it takes several. */
  images?: { name: string; many: boolean; required: boolean };
  size?:
    | { kind: "object"; name: string }
    | { kind: "pair" }
    | { kind: "choice"; name: string; choices: string[] };
}

const COUNT_FIELDS = ["num_images", "num_outputs", "number_of_images", "n"];
const IMAGE_FIELDS = [
  "image_urls",
  "image_url",
  "input_images",
  "input_image",
  "image_input",
  "reference_images",
  "images",
  "image",
];

function record(value: unknown): Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : {};
}

/** A property with the schemas it refers to folded in, so its type and choices are its own. */
function resolved(property: unknown, schemas: Schema): Schema {
  const schema = record(property);
  const parts = [schema.allOf, schema.anyOf, schema.oneOf].flatMap((list) =>
    Array.isArray(list) ? list : [],
  );
  const reference = (one: Schema) =>
    typeof one.$ref === "string"
      ? record(schemas[one.$ref.split("/").pop() ?? ""])
      : one;
  const all = [
    reference(schema),
    ...parts.map((part) => reference(record(part))),
  ];
  return {
    types: all.flatMap((one) =>
      typeof one.type === "string" ? [one.type] : [],
    ),
    choices: all.flatMap((one) =>
      Array.isArray(one.enum)
        ? one.enum.filter((choice) => typeof choice === "string")
        : [],
    ),
  };
}

/** The fields of a model's input schema, or nothing when it takes no prompt. */
export function fieldsOf(
  input: unknown,
  schemas: unknown,
): ModelFields | undefined {
  const properties = record(record(input).properties);
  const required = record(input).required;
  const has = (name: string) => Object.hasOwn(properties, name);
  if (!has("prompt")) return undefined;
  const describe = (name: string) =>
    resolved(properties[name], record(schemas));
  const fields: ModelFields = { prompt: "prompt" };
  fields.count = COUNT_FIELDS.find(has);
  const images = IMAGE_FIELDS.find(has);
  if (images)
    fields.images = {
      name: images,
      many: (describe(images).types as string[]).includes("array"),
      required: Array.isArray(required) && required.includes(images),
    };
  if (has("image_size")) fields.size = { kind: "object", name: "image_size" };
  else if (has("width") && has("height")) fields.size = { kind: "pair" };
  else
    for (const name of ["aspect_ratio", "size"]) {
      const choices = (describe(name).choices as string[]).filter(parseSize);
      if (has(name) && choices.length) {
        fields.size = { kind: "choice", name, choices };
        break;
      }
    }
  return fields;
}

/** The one of a model's size choices closest to `size`: each is `W:H` or `WxH`. */
function choiceFor(size: Size, choices: string[]): string {
  const exact = choices.filter((choice) => /x/i.test(choice));
  if (!exact.length) return nearestRatio(size, choices);
  const nearest = nearestSize(
    size,
    exact.map((choice) => parseSize(choice) as Size),
  );
  return exact.find((choice) => {
    const parsed = parseSize(choice) as Size;
    return parsed.width === nearest.width && parsed.height === nearest.height;
  }) as string;
}

/**
 * A request written as one model's input. Rejects when the model has no
 * field for a part the request sets. `source` gives the form the host takes
 * an image to edit in, a link or a `data:` URL, and is asked only once the
 * request is known to fit the model.
 */
export async function inputFor(
  fields: ModelFields,
  request: ImageRequest,
  source: (image: SourceImage) => string | Promise<string>,
): Promise<Record<string, unknown>> {
  const { model, size, images, numImages } = request;
  const input: Record<string, unknown> = { [fields.prompt]: request.prompt };
  if (fields.count) input[fields.count] = numImages;
  else if (numImages > 1)
    throw new Error(
      `${model.id} makes one image a request. Leave numImages out.`,
    );
  if (size) {
    if (!fields.size)
      throw new Error(`${model.id} takes no size. Leave width and height out.`);
    if (fields.size.kind === "pair") Object.assign(input, size);
    else if (fields.size.kind === "object") input[fields.size.name] = size;
    else input[fields.size.name] = choiceFor(size, fields.size.choices);
  }
  if (images.length) {
    if (!fields.images) throw new Error(`${model.id} takes no images.`);
    if (!fields.images.many && images.length > 1)
      throw new Error(`${model.id} takes one image. Pass one path in images.`);
    const urls = await Promise.all(images.map(source));
    input[fields.images.name] = fields.images.many ? urls : urls[0];
  }
  return input;
}
