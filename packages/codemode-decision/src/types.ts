/**
 * What a decision is to the plugin, whichever provider answers: evidence,
 * questions of three types about it, and a typed answer with probabilities
 * for each. And what a provider of decision models is.
 */

import type { LocalImage, RoutedProvider } from "@shiftlabs/codemode";

/** One of the values a choice question selects among. */
export interface Option {
  value: string;
  /** When the option applies. An option without one is read by its value alone. */
  description?: string;
}

/** One level of a score question's scale. */
export interface Level {
  label: string;
  /** What puts the evidence at this level. */
  description?: string;
}

/** A question about the evidence, by the name its answer comes back under. */
export type Question = { name: string; instructions: string } & (
  | { type: "yesNo" }
  | { type: "choice"; options: Option[] }
  | { type: "score"; levels: Level[] }
);

/** One request for decisions, the same for every provider. */
export interface Decision {
  model: string;
  /** The evidence every question is about: text, or a JSON object. */
  input?: string | Record<string, unknown>;
  /** Images that are part of the evidence, in order. */
  images: LocalImage[];
  questions: Question[];
}

/** The answer to one question. */
export type Answer =
  /** How likely the answer is yes, from 0 to 1. */
  | { type: "yesNo"; probability: number }
  | {
      type: "choice";
      /** The option's value. */
      choice: string;
      confidence: number;
      /** Every option's probability, in the question's order. */
      probabilities: Array<{ value: string; probability: number }>;
    }
  | {
      type: "score";
      /** The probability-weighted average of the levels' positions, from 0. It can fall between levels. */
      score: number;
      confidence: number;
      /** Every level's probability, from the lowest level. */
      probabilities: Array<{
        level: number;
        label: string;
        probability: number;
      }>;
    }
  /** The model declined to answer this question. */
  | { type: "refusal" };

/** What a provider answered for one request. */
export interface Answered {
  /** The model that answered, which can be a version of the one asked for. */
  model: string;
  /** An answer for each question, in the questions' order, or nothing where the provider gave none that reads. */
  answers: Array<Answer | undefined>;
  inputTokens?: number;
}

/** A decision API: where it is, where its key goes, and how a decision reads to and from it. */
export interface DecisionProvider extends RoutedProvider {
  /** The HTTPS address the key may be sent beneath, ending in `/`. */
  baseUrl: string;
  /** The path of the decision endpoint beneath `baseUrl`. */
  path: string;
  /** The model a request uses when the connection names none. */
  model: string;
  /** The least and most pixels it takes on each side of an image. */
  imageSides?: { min: number; max: number };
  /** The request a decision becomes: its JSON body, and any headers beside the key's. */
  request(decision: Decision): {
    json: unknown;
    headers?: Record<string, string>;
  };
  /** The headers `request` may set. */
  headers?: string[];
  /** The answers in the provider's response to `decision`. */
  answers(response: unknown, decision: Decision): Answered;
}
