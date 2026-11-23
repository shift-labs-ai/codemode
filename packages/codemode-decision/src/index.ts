/**
 * Decision models for codemode: ask yes-or-no, choice and score questions
 * about some evidence and get typed answers with probabilities, through the
 * provider the connection chooses. Code never names a provider.
 *
 *   const { answers } = await decision.ask({
 *     input: "I was charged twice for my order.",
 *     questions: { refund: { type: "yesNo", instructions: "Does the customer ask for a refund?" } },
 *   })
 *   // answers.refund -> { type: "yesNo", probability: 0.97 }
 *
 * A connection holds a key per provider. Each key is declared with the one
 * address that may receive it, so a request to one provider sends no other
 * provider's key.
 */

import {
  type ActionContext,
  type CodemodePluginAPI,
  credentialJson,
  keyedProviders,
  type LocalImage,
  namedProvider,
  type PluginFunction,
  readLocalImage,
  routerConnectionFields,
  routerCredential,
} from "@shiftlabs/codemode";
import { packageVersion } from "@shiftlabs/codemode/utils/cli";
import * as t from "typebox";
import { PROVIDERS } from "./providers.js";
import type { DecisionProvider, Question } from "./types.js";

export * from "./providers.js";
export * from "./types.js";

const NAME = "decision";
/** The most questions every provider takes in one request. */
const MAX_QUESTIONS = 400;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 255;
const MIN_LEVELS = 2;
const MAX_LEVELS = 10;
const MAX_IMAGES = 8;
/** The largest image file every provider takes. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** The types of image every provider takes. */
const IMAGE_TYPES = ["image/png", "image/jpeg"];
const TIMEOUT_MS = 60_000;

const text = (description: string) => t.String({ minLength: 1, description });

const question = t.Object(
  {
    type: t.String({
      enum: ["yesNo", "choice", "score"],
      description:
        "yesNo: how likely the answer is yes. choice: one of options. score: a place on the scale of levels",
    }),
    instructions: text(
      "What to decide about the input, as a question or a statement. Ask about one thing that can be observed",
    ),
    options: t.Optional(
      t.Array(
        t.Object(
          {
            value: text(
              "The value the answer returns. A meaningful label, such as billing",
            ),
            description: t.Optional(text("When this option applies")),
          },
          { additionalProperties: false },
        ),
        {
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          description: `For choice: ${MIN_OPTIONS} to ${MAX_OPTIONS} options with different values. Add one such as other when the options may not cover every input`,
        },
      ),
    ),
    levels: t.Optional(
      t.Array(
        t.Object(
          {
            label: text("A short name for the level, such as Fully blocked"),
            description: t.Optional(text("What puts the input at this level")),
          },
          { additionalProperties: false },
        ),
        {
          minItems: MIN_LEVELS,
          maxItems: MAX_LEVELS,
          description: `For score: ${MIN_LEVELS} to ${MAX_LEVELS} levels, from the lowest to the highest`,
        },
      ),
    ),
  },
  { additionalProperties: false },
);

type QuestionInput = t.Static<typeof question>;

/** A question as the providers receive it, or an error that says what its type takes. */
function asked(name: string, input: QuestionInput): Question {
  if (!name.trim()) throw new Error(`${NAME}: a question has no name.`);
  const { instructions, options, levels } = input;
  const needs = (field: "options" | "levels" | undefined) => {
    for (const other of ["options", "levels"] as const)
      if (other !== field && input[other])
        throw new Error(
          `${NAME}: question ${JSON.stringify(name)} is a ${input.type} question, which takes no ${other}.`,
        );
    if (field && !input[field])
      throw new Error(
        `${NAME}: question ${JSON.stringify(name)} is a ${input.type} question, which needs ${field}.`,
      );
  };
  if (input.type === "choice") {
    needs("options");
    const values = (options ?? []).map(({ value }) => value);
    const repeated = values.find(
      (value, index) => values.indexOf(value) !== index,
    );
    if (repeated !== undefined)
      throw new Error(
        `${NAME}: question ${JSON.stringify(name)} has the option ${JSON.stringify(repeated)} twice.`,
      );
    return { type: "choice", name, instructions, options: options ?? [] };
  }
  if (input.type === "score") {
    needs("levels");
    return { type: "score", name, instructions, levels: levels ?? [] };
  }
  needs(undefined);
  return { type: "yesNo", name, instructions };
}

const probability = { type: "number", minimum: 0, maximum: 1 };

/**
 * The `decision` plugin over `providers`, in the order one is chosen when
 * the connection names none. A host adds a provider of its own by passing a
 * list that includes it.
 */
export function decision(
  providers: DecisionProvider[] = PROVIDERS,
): PluginFunction {
  const credential = routerCredential(
    "codemodeDecision",
    providers,
    ({ name, baseUrl, headers }) => ({
      [name]: {
        baseUrl,
        methods: ["POST"],
        ...(headers ? { allowedHeaders: headers } : {}),
        timeoutMs: TIMEOUT_MS,
      },
    }),
  );

  /**
   * The provider a request goes to. The connection decides, never the call:
   * its `provider` when it names one, else the first provider it has a key
   * for.
   */
  function chosen(ctx: ActionContext): DecisionProvider {
    const { config } = ctx.connection;
    return (
      namedProvider(NAME, providers, config, !ctx.credentials) ??
      keyedProviders(NAME, "decision", providers, config)[0]
    );
  }

  /** Read an image of the evidence, and refuse one the provider's model does not take. */
  async function evidence(
    provider: DecisionProvider,
    path: string,
  ): Promise<LocalImage> {
    const image = await readLocalImage(path, {
      subject: `${NAME}: ${path}`,
      maxBytes: MAX_IMAGE_BYTES,
      types: IMAGE_TYPES,
    });
    const sides = provider.imageSides;
    const { width, height } = image;
    if (
      sides &&
      width !== undefined &&
      height !== undefined &&
      (Math.min(width, height) < sides.min ||
        Math.max(width, height) > sides.max)
    )
      throw new Error(
        `${NAME}: ${path} is ${width}x${height} pixels. Resize it so each side is from ${sides.min} to ${sides.max} pixels.`,
      );
    return image;
  }

  return function plugin(rl: CodemodePluginAPI): void {
    rl.setName(NAME);
    rl.setVersion(packageVersion(import.meta.url));
    rl.setDescription(
      "Ask a decision model yes-or-no, choice and score questions, and get typed answers with probabilities.",
    );
    rl.setCredential(credential);
    rl.setConnectionSchema(
      t.Object({
        ...routerConnectionFields(
          providers,
          "The provider every request goes to. The default is the first provider with a key",
        ),
        model: t.Optional(
          t.String({
            minLength: 1,
            description:
              "The model every request uses. The default is the provider's",
          }),
        ),
      }),
    );

    rl.registerAction("ask", {
      access: "read",
      description:
        "Ask questions about some text, JSON or images and get a typed answer with probabilities for each: how likely a yes, one of a set of options, or a place on a scale. For classifying, routing and scoring, in one fast call. Billed by the provider.",
      hints: { openWorld: true },
      inputSchema: t.Object(
        {
          input: t.Optional(
            t.Union(
              [t.String({ minLength: 1 }), t.Record(t.String(), t.Unknown())],
              {
                description:
                  "What every question is about: text, or a JSON object of named fields. Needed unless images is set",
              },
            ),
          ),
          images: t.Optional(
            t.Array(t.String({ minLength: 1 }), {
              minItems: 1,
              maxItems: MAX_IMAGES,
              description: `Paths of 1 to ${MAX_IMAGES} image files (PNG or JPEG) that are part of what every question is about`,
            }),
          ),
          questions: t.Record(t.String(), question, {
            minProperties: 1,
            maxProperties: MAX_QUESTIONS,
            description: `1 to ${MAX_QUESTIONS} questions, each under the name its answer comes back under. Each is answered on its own: one answer is no input to another`,
          }),
        },
        { additionalProperties: false },
      ),
      outputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          inputTokens: { type: "integer" },
          answers: {
            type: "object",
            description: "An answer for each question, under its name",
            additionalProperties: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["yesNo", "choice", "score", "refusal"],
                },
                probability,
                choice: { type: "string" },
                score: { type: "number" },
                confidence: probability,
                probabilities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      value: { type: "string" },
                      level: { type: "integer" },
                      label: { type: "string" },
                      probability,
                    },
                    required: ["probability"],
                  },
                },
              },
              required: ["type"],
            },
          },
        },
        required: ["provider", "model", "answers"],
      },
      async execute(input, ctx) {
        if (input.input === undefined && !input.images)
          throw new Error(`${NAME}: set input, images, or both.`);
        const questions = Object.entries(input.questions).map(([name, one]) =>
          asked(name, one),
        );
        const provider = chosen(ctx);
        const configured = ctx.connection.config.model;
        const images = await Promise.all(
          (input.images ?? []).map((path) => evidence(provider, path)),
        );
        const request = {
          model:
            typeof configured === "string" && configured
              ? configured
              : provider.model,
          input: input.input,
          images,
          questions,
        };
        const { json, headers } = provider.request(request);
        const response = await credentialJson(
          ctx,
          credential,
          `${NAME}.${provider.name}`,
          {
            target: provider.name,
            path: provider.path,
            method: "POST",
            json,
            ...(headers ? { headers } : {}),
          },
        );
        const { model, answers, inputTokens } = provider.answers(
          response,
          request,
        );
        return {
          provider: provider.name,
          model: model || request.model,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          answers: Object.fromEntries(
            questions.map(({ name }, index) => {
              const answer = answers[index];
              if (!answer)
                throw new Error(
                  `${NAME}: ${provider.name} answered nothing that reads for question ${JSON.stringify(name)}.`,
                );
              return [name, answer];
            }),
          ),
        };
      },
    });
  };
}

export default decision();
