import type { ImageProvider } from "../types.js";
import { fal } from "./fal.js";
import { google } from "./google.js";
import { openai } from "./openai.js";
import { recraft } from "./recraft.js";
import { replicate } from "./replicate.js";
import { together } from "./together.js";
import { xai } from "./xai.js";

export { fal, google, openai, recraft, replicate, together, xai };

/**
 * Every provider, in the order one is chosen when the connection names
 * none: those that make their own models, then those that host others'.
 */
export const PROVIDERS: ImageProvider[] = [
  openai,
  google,
  xai,
  recraft,
  together,
  fal,
  replicate,
];
