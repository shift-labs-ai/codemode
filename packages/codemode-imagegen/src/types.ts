/**
 * What an image provider is to the plugin: where it is and where its key
 * goes, the models it has, and how one request for images is made of it.
 */

import type { Size } from "./size.js";

/** A model a provider makes images with. */
export interface ImageModel {
  /** The id the provider's API takes, and the one code passes as `model`. */
  id: string;
  name?: string;
  description?: string;
  /** Whether it makes an image from a prompt alone. */
  create: boolean;
  /** Whether it makes an image from a prompt and images. */
  edit: boolean;
}

/** An image read from disk to edit. */
export interface SourceImage {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  fileName: string;
}

/** One request for images, the same for every provider. */
export interface ImageRequest {
  prompt: string;
  model: ImageModel;
  numImages: number;
  /** The pixels asked for. A provider gets as close as its model allows. */
  size?: Size;
  /** The images to edit, in order. Empty when the request creates one. */
  images: SourceImage[];
}

/** An image as a provider hands it over: its bytes in base64, or where to fetch them. */
export type ProducedImage = { base64: string } | { url: string };

/** One request to a provider's API. */
export interface ApiCall {
  /** The provider's target to call. The default is its first. */
  target?: string;
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, unknown>;
  json?: unknown;
  /** A body that is not JSON, with its `Content-Type` among `headers`. */
  body?: Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
}

/** What a provider reaches the outside through. The plugin signs and sends. */
export interface ProviderApi {
  /** Send a signed request to one of the provider's targets and read its JSON answer. */
  request<T = unknown>(call: ApiCall): Promise<T>;
  /** Wait, or reject when the run that asked ends. */
  wait(ms: number): Promise<void>;
}

/** An address a provider's key may be sent beneath. */
export interface ProviderTarget {
  /** An HTTPS address ending in `/`. */
  baseUrl: string;
  methods: Array<"GET" | "POST">;
  /** Headers its requests carry beside `Accept` and `Content-Type`. */
  allowedHeaders?: string[];
}

/** An image API: where it is, where its key goes, its models, and how it makes images. */
export interface ImageProvider {
  /** The name a connection gives as its `provider`, and the stem of the key's connection field. */
  name: string;
  /** The environment variable that fills the key. */
  env: string;
  /** Where the key goes in a request: a header, or a query parameter. */
  key: { header: string; prefix?: string } | { query: string };
  /** The addresses the key may be sent beneath, by a name no other provider uses. The first is the default. */
  targets: Record<string, ProviderTarget>;
  /** Hosts its images are fetched from, each with its subdomains. Fetches carry no key. */
  downloads?: string[];
  /** The model each action uses when neither the call nor the connection names one. */
  defaults: { create: string; edit?: string };
  /** The models the package knows of. A live list is laid over these. */
  models: ImageModel[];
  /** The provider's own list of its image models, where its API has one: all of them, or those that match `query`. */
  listModels?(api: ProviderApi, query?: string): Promise<ImageModel[]>;
  /** One model by its id, for a provider with more models than a list holds. */
  findModel?(api: ProviderApi, id: string): Promise<ImageModel | undefined>;
  /** Make the images of one request. */
  generate(api: ProviderApi, request: ImageRequest): Promise<ProducedImage[]>;
}
