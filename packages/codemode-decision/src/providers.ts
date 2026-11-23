/**
 * The providers of decision models: for each, where its key goes, the
 * request a decision becomes, and how its response reads as answers. A
 * provider is data and two functions; the plugin sends the request.
 */

import { randomUUID } from "node:crypto";
import { imageBase64, imageDataUrl } from "@shiftlabs/codemode";
import type { Answer, Answered, DecisionProvider, Question } from "./types.js";

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * A choice or score answer over `probabilities`, one for each option or
 * level in the question's order, or nothing when a number it needs is not
 * there.
 */
function distributed(
  question: Question,
  answer: Json,
  probability: (index: number) => unknown,
): Answer | undefined {
  const confidence = number(answer.confidence);
  if (confidence === undefined) return undefined;
  if (question.type === "choice") {
    const probabilities = question.options.map(({ value }, index) => ({
      value,
      probability: number(probability(index)) ?? 0,
    }));
    return typeof answer.choice === "string"
      ? { type: "choice", choice: answer.choice, confidence, probabilities }
      : undefined;
  }
  if (question.type === "score") {
    const score = number(answer.score);
    const probabilities = question.levels.map(({ label }, level) => ({
      level,
      label,
      probability: number(probability(level)) ?? 0,
    }));
    return score === undefined
      ? undefined
      : { type: "score", score, confidence, probabilities };
  }
  return undefined;
}

/**
 * OpenAI's Decisions API. Questions are a list, each with its name, and the
 * answers come back in the same order. Evidence is a string, or one user
 * message of text, JSON and image parts.
 */
export const openai: DecisionProvider = {
  name: "openai",
  env: "OPENAI_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.openai.com/v1/",
  path: "decisions",
  model: "gpt-6-luna",
  request({ model, input, images, questions }) {
    const parts = [
      ...(typeof input === "string"
        ? [{ type: "input_text", text: input }]
        : input
          ? [{ type: "input_json", data: input }]
          : []),
      ...images.map((image) => ({
        type: "input_image",
        image_url: imageDataUrl(image),
      })),
    ];
    return {
      json: {
        model,
        input:
          typeof input === "string" && !images.length
            ? input
            : [{ role: "user", content: parts }],
        questions: questions.map((question) => {
          const { name, instructions } = question;
          if (question.type === "choice")
            return {
              type: "choice",
              name,
              instructions,
              choices: question.options,
            };
          if (question.type === "score")
            return {
              type: "score",
              name,
              instructions,
              levels: question.levels,
            };
          return { type: "predicate", name, instructions };
        }),
      },
    };
  },
  answers(response, { questions }): Answered {
    const body = object(response);
    const answers = Array.isArray(body.answers) ? body.answers : [];
    return {
      model: typeof body.model === "string" ? body.model : "",
      inputTokens: number(object(body.usage).input_tokens),
      answers: questions.map((question, index): Answer | undefined => {
        const answer = object(answers[index]);
        if (answer.type === "refusal") return { type: "refusal" };
        if (question.type === "yesNo") {
          const probability = number(answer.probability);
          return answer.type === "predicate" && probability !== undefined
            ? { type: "yesNo", probability }
            : undefined;
        }
        if (answer.type !== question.type) return undefined;
        // Each probability names its option's value, or its level's position.
        const listed = Array.isArray(answer.probabilities)
          ? answer.probabilities.map(object)
          : [];
        return distributed(question, answer, (index) => {
          const key =
            question.type === "choice" ? question.options[index].value : index;
          return listed.find((one) => one.value === key)?.probability;
        });
      }),
    };
  },
};

/**
 * TypeSafe's System One API. Questions and answers are objects keyed by the
 * question's name; a choice's options and a score's levels are its
 * `criteria`. An image is an asset, and stands wherever its reference is
 * written in the state.
 */
export const typesafe: DecisionProvider = {
  name: "typesafe",
  env: "TYPESAFE_API_KEY",
  key: { header: "Authorization", prefix: "Bearer " },
  baseUrl: "https://api.typesafe.ai/v1/",
  path: "systemone",
  model: "jev-latest",
  imageSides: { min: 280, max: 1568 },
  headers: ["TypeSafe-Danger-Zone-Images"],
  request({ model, input, images, questions }) {
    // A reference stands for its image wherever it is written, so each is one no text holds by accident.
    const assets = images.map((image) => ({
      reference: randomUUID(),
      asset: {
        type: "image",
        format: image.mimeType === "image/png" ? "png" : "jpg",
        data_base64: imageBase64(image),
      },
    }));
    return {
      json: {
        model,
        state: assets.length
          ? {
              ...(input === undefined ? {} : { input }),
              images: assets.map(({ reference }) => reference),
            }
          : input,
        questions: Object.fromEntries(
          questions.map((question) => {
            const { name, instructions } = question;
            if (question.type === "choice")
              return [
                name,
                {
                  type: "choice",
                  instructions,
                  criteria: Object.fromEntries(
                    question.options.map(({ value, description }) => [
                      value,
                      description ?? null,
                    ]),
                  ),
                },
              ];
            if (question.type === "score")
              return [
                name,
                {
                  type: "score",
                  instructions,
                  criteria: question.levels.map(({ label, description }) =>
                    description ? `${label}: ${description}` : label,
                  ),
                },
              ];
            return [name, { type: "noul", instructions }];
          }),
        ),
        ...(assets.length
          ? {
              assets: Object.fromEntries(
                assets.map(({ reference, asset }) => [reference, asset]),
              ),
            }
          : {}),
      },
      ...(assets.length
        ? { headers: { "TypeSafe-Danger-Zone-Images": "true" } }
        : {}),
    };
  },
  answers(response, { questions }): Answered {
    const body = object(response);
    const answers = object(body.answers);
    return {
      model: typeof body.model === "string" ? body.model : "",
      inputTokens: number(object(body.usage).input_tokens),
      answers: questions.map((question): Answer | undefined => {
        const answer = object(answers[question.name]);
        if (question.type === "yesNo") {
          const probability = number(answer.noul);
          return answer.type === "noul" && probability !== undefined
            ? { type: "yesNo", probability }
            : undefined;
        }
        if (answer.type !== question.type) return undefined;
        // Probabilities are keyed by the option's value, or the level's position.
        const probabilities = object(answer.probabilities);
        return distributed(
          question,
          answer,
          (index) =>
            probabilities[
              question.type === "choice"
                ? question.options[index].value
                : String(index)
            ],
        );
      }),
    };
  },
};

/** Every provider, in the order one is chosen when the connection names none. */
export const PROVIDERS: DecisionProvider[] = [openai, typesafe];
