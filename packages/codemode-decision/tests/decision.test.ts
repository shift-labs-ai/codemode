/**
 * The decision package: its action through a real engine with the
 * providers' hosts stood in for, and the package as codemode's package
 * manager loads it.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stubFetch } from "../../codemode/src/tests/helpers/plugin.js";
import { describePackage, pluginHarness } from "../../package-tests/harness.js";
import decisionPlugin, {
  type DecisionProvider,
  decision,
  PROVIDERS,
} from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answer every request with `answer`, and collect what was sent. */
function serve(answer: unknown, status = 200): Sent[] {
  const all: Sent[] = [];
  stubFetch(async (url, init) => {
    all.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(Buffer.from(init?.body as Uint8Array).toString()),
    });
    return Response.json(answer, { status });
  });
  return all;
}

const harness = pluginHarness(decisionPlugin, "decision");

/** A connection with a key for every provider. */
const ALL_KEYS = Object.fromEntries(
  PROVIDERS.map(({ name }) => [`${name}ApiKey`, `KEY-${name}`]),
);
/** A connection with a key for every provider, whose provider is `name`. */
const through = (name: string) => ({ ...ALL_KEYS, provider: name });

async function run(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  return harness
    .codemode(config)
    .execute(`return await decision.ask(${JSON.stringify(input)})`);
}

async function ask<T = Record<string, unknown>>(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<T> {
  const { result, error } = await run(input, config);
  assert.equal(error, undefined);
  return result as T;
}

async function refused(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<string> {
  const { error } = await run(input, config);
  assert.ok(error, "the call should fail");
  return error.split("\n")[0];
}

/** The first bytes of a PNG of this size: all that tells an image's type and size. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function image(name: string, width = 640, height = 480): string {
  const path = join(harness.tmp, name);
  writeFileSync(path, png(width, height));
  return path;
}

const TICKET = "I was charged twice for my order.";
/** One question of each type. */
const QUESTIONS = {
  refund: {
    type: "yesNo",
    instructions: "Does the customer ask for a refund?",
  },
  department: {
    type: "choice",
    instructions: "Which department should handle this?",
    options: [
      { value: "billing", description: "Payments, invoices and refunds." },
      { value: "technical" },
    ],
  },
  severity: {
    type: "score",
    instructions: "How severe is this?",
    levels: [
      { label: "Cosmetic", description: "Appearance only." },
      { label: "Blocked" },
    ],
  },
};
/** What both providers' answers below read as. */
const ANSWERS = {
  refund: { type: "yesNo", probability: 0.9 },
  department: {
    type: "choice",
    choice: "billing",
    confidence: 0.8,
    probabilities: [
      { value: "billing", probability: 0.95 },
      { value: "technical", probability: 0.05 },
    ],
  },
  severity: {
    type: "score",
    score: 0.7,
    confidence: 0.4,
    probabilities: [
      { level: 0, label: "Cosmetic", probability: 0.3 },
      { level: 1, label: "Blocked", probability: 0.7 },
    ],
  },
};

const OPENAI_ANSWER = {
  model: "gpt-6-luna",
  answers: [
    { type: "predicate", name: "refund", probability: 0.9 },
    {
      type: "choice",
      name: "department",
      choice: "billing",
      confidence: 0.8,
      probabilities: [
        { value: "technical", probability: 0.05 },
        { value: "billing", probability: 0.95 },
      ],
    },
    {
      type: "score",
      name: "severity",
      score: 0.7,
      confidence: 0.4,
      probabilities: [
        { value: 0, label: "Cosmetic", probability: 0.3 },
        { value: 1, label: "Blocked", probability: 0.7 },
      ],
    },
  ],
  usage: { input_tokens: 42, output_tokens: 0 },
};
const TYPESAFE_ANSWER = {
  model: "jev-1.14.0",
  answers: {
    severity: {
      type: "score",
      score: 0.7,
      confidence: 0.4,
      legend: { "0": "Cosmetic: Appearance only.", "1": "Blocked" },
      probabilities: { "0": 0.3, "1": 0.7 },
    },
    refund: { type: "noul", noul: 0.9 },
    department: {
      type: "choice",
      choice: "billing",
      confidence: 0.8,
      probabilities: { billing: 0.95, technical: 0.05 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
};

describe("decision.ask through each provider", () => {
  it("openai: sends its API's request with its own key alone, and reads its answers", async () => {
    const sent = serve(OPENAI_ANSWER);
    const result = await ask(
      { input: TICKET, questions: QUESTIONS },
      through("openai"),
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.openai.com/v1/decisions");
    assert.equal(sent[0].headers.authorization, "Bearer KEY-openai");
    assert.ok(!JSON.stringify(sent).includes("KEY-typesafe"));
    assert.deepEqual(sent[0].body, {
      model: "gpt-6-luna",
      input: TICKET,
      questions: [
        {
          type: "predicate",
          name: "refund",
          instructions: "Does the customer ask for a refund?",
        },
        {
          type: "choice",
          name: "department",
          instructions: "Which department should handle this?",
          choices: [
            {
              value: "billing",
              description: "Payments, invoices and refunds.",
            },
            { value: "technical" },
          ],
        },
        {
          type: "score",
          name: "severity",
          instructions: "How severe is this?",
          levels: [
            { label: "Cosmetic", description: "Appearance only." },
            { label: "Blocked" },
          ],
        },
      ],
    });
    assert.deepEqual(result, {
      provider: "openai",
      model: "gpt-6-luna",
      inputTokens: 42,
      answers: ANSWERS,
    });
  });

  it("typesafe: sends its API's request with its own key alone, and reads the same answers", async () => {
    const sent = serve(TYPESAFE_ANSWER);
    const result = await ask(
      { input: TICKET, questions: QUESTIONS },
      through("typesafe"),
    );
    assert.equal(sent[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(sent[0].headers.authorization, "Bearer KEY-typesafe");
    assert.equal(sent[0].headers["typesafe-danger-zone-images"], undefined);
    assert.ok(!JSON.stringify(sent).includes("KEY-openai"));
    assert.deepEqual(sent[0].body, {
      model: "jev-latest",
      state: TICKET,
      questions: {
        refund: {
          type: "noul",
          instructions: "Does the customer ask for a refund?",
        },
        department: {
          type: "choice",
          instructions: "Which department should handle this?",
          criteria: {
            billing: "Payments, invoices and refunds.",
            technical: null,
          },
        },
        severity: {
          type: "score",
          instructions: "How severe is this?",
          criteria: ["Cosmetic: Appearance only.", "Blocked"],
        },
      },
    });
    assert.deepEqual(result, {
      provider: "typesafe",
      // The version that answered, not the alias that was asked for.
      model: "jev-1.14.0",
      inputTokens: 120,
      answers: ANSWERS,
    });
  });

  it("sends a JSON object as each provider takes structured evidence", async () => {
    const order = { ticket: { body: TICKET }, order: { charges: [49, 49] } };
    const questions = { refund: QUESTIONS.refund };
    const openai = serve({ answers: [OPENAI_ANSWER.answers[0]] });
    await ask({ input: order, questions }, through("openai"));
    assert.deepEqual(openai[0].body.input, [
      { role: "user", content: [{ type: "input_json", data: order }] },
    ]);
    const typesafe = serve({ answers: { refund: { type: "noul", noul: 1 } } });
    await ask({ input: order, questions }, through("typesafe"));
    assert.deepEqual(typesafe[0].body.state, order);
  });

  it("answers a refusal as an answer, beside the questions that were answered", async () => {
    serve({
      model: "gpt-6-luna",
      answers: [{ type: "refusal", name: "refund" }, OPENAI_ANSWER.answers[1]],
    });
    const { answers } = await ask<{ answers: Record<string, unknown> }>(
      {
        input: TICKET,
        questions: {
          refund: QUESTIONS.refund,
          department: QUESTIONS.department,
        },
      },
      through("openai"),
    );
    assert.deepEqual(answers, {
      refund: { type: "refusal" },
      department: ANSWERS.department,
    });
  });
});

describe("images", () => {
  const questions = {
    damaged: { type: "yesNo", instructions: "Is it damaged?" },
  };
  const dataUrl = `data:image/png;base64,${png(640, 480).toString("base64")}`;

  it("openai: go beside the input, as parts of one message", async () => {
    const sent = serve({ answers: [{ type: "predicate", probability: 0.2 }] });
    await ask(
      { input: "Inspect the product.", images: [image("a.png")], questions },
      through("openai"),
    );
    assert.deepEqual(sent[0].body.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect the product." },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ]);
    await ask({ images: [image("a.png")], questions }, through("openai"));
    assert.deepEqual(sent[1].body.input, [
      { role: "user", content: [{ type: "input_image", image_url: dataUrl }] },
    ]);
  });

  it("typesafe: are assets the state refers to, with images turned on", async () => {
    const sent = serve({ answers: { damaged: { type: "noul", noul: 0.2 } } });
    await ask(
      {
        input: "Inspect the product.",
        images: [image("a.png"), image("b.png")],
        questions,
      },
      through("typesafe"),
    );
    const { state, assets } = sent[0].body as {
      state: { input: string; images: string[] };
      assets: Record<string, unknown>;
    };
    assert.equal(sent[0].headers["typesafe-danger-zone-images"], "true");
    assert.equal(state.input, "Inspect the product.");
    assert.equal(new Set(state.images).size, 2);
    assert.deepEqual(Object.keys(assets), state.images);
    assert.deepEqual(assets[state.images[0]], {
      type: "image",
      format: "png",
      data_base64: png(640, 480).toString("base64"),
    });
  });

  it("are refused before any request when a file is no PNG or JPEG, or is a size the provider does not take", async () => {
    const sent = serve({});
    const gif = join(harness.tmp, "anim.png");
    writeFileSync(
      gif,
      Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]),
    );
    assert.match(
      await refused({ images: [gif], questions }, through("openai")),
      /anim\.png is not a PNG or JPEG image\./,
    );
    assert.match(
      await refused(
        { images: [image("small.png", 200, 400)], questions },
        through("typesafe"),
      ),
      /small\.png is 200x400 pixels\. Resize it so each side is from 280 to 1568 pixels\./,
    );
    assert.match(
      await refused(
        { images: [image("large.png", 1600, 1200)], questions },
        through("typesafe"),
      ),
      /large\.png is 1600x1200 pixels\./,
    );
    assert.equal(sent.length, 0);
    // OpenAI documents no such bounds, so the same file goes to it.
    serve({ answers: [{ type: "predicate", probability: 0.2 }] });
    await ask(
      { images: [image("large.png", 1600, 1200)], questions },
      through("openai"),
    );
  });
});

describe("the provider and model a request uses", () => {
  const questions = { refund: QUESTIONS.refund };
  const answer = { answers: { refund: { type: "noul", noul: 0.5 } } };

  it("are the first provider with a key, and its own model", async () => {
    const sent = serve(answer);
    const result = await ask<{ provider: string; model: string }>(
      { input: TICKET, questions },
      { typesafeApiKey: "t" },
    );
    assert.equal(sent[0].body.model, "jev-latest");
    // A provider that names no model in its answer used the one it was asked for.
    assert.deepEqual(
      [result.provider, result.model],
      ["typesafe", "jev-latest"],
    );
    serve({ answers: [OPENAI_ANSWER.answers[0]] });
    assert.equal(
      (await ask<{ provider: string }>({ input: TICKET, questions }, ALL_KEYS))
        .provider,
      "openai",
    );
  });

  it("are the connection's when it names them", async () => {
    const sent = serve(answer);
    await ask(
      { input: TICKET, questions },
      { ...through("typesafe"), model: "jev-1.13.0" },
    );
    assert.equal(sent[0].body.model, "jev-1.13.0");
  });

  it("are never the call's: the action has no input that names either", async () => {
    serve(answer);
    for (const extra of [{ provider: "typesafe" }, { model: "jev-1.13.0" }])
      assert.match(
        await refused({ input: TICKET, questions, ...extra }, ALL_KEYS),
        /Invalid input for decision\.ask/,
      );
  });

  it("are refused when no provider has a key, or the connection's has none", async () => {
    serve(answer);
    const none = await refused({ input: TICKET, questions }, {});
    assert.match(
      none,
      /decision: no decision provider has a key\. Set one of /,
    );
    for (const { env } of PROVIDERS) assert.ok(none.includes(env), env);
    assert.equal(
      await refused(
        { input: TICKET, questions },
        { openaiApiKey: "o", provider: "typesafe" },
      ),
      "Error: decision: no key for typesafe, the connection's provider. Set TYPESAFE_API_KEY.",
    );
  });
});

describe("what a request accepts", () => {
  const yesNo = QUESTIONS.refund;

  it("refuses a question whose fields are not its type's, before any request", async () => {
    const sent = serve({});
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { type: "choice", instructions: "Which?" },
        'Error: decision: question "q" is a choice question, which needs options.',
      ],
      [
        { type: "score", instructions: "How?" },
        'Error: decision: question "q" is a score question, which needs levels.',
      ],
      [
        { ...yesNo, options: QUESTIONS.department.options },
        'Error: decision: question "q" is a yesNo question, which takes no options.',
      ],
      [
        { ...QUESTIONS.department, levels: QUESTIONS.severity.levels },
        'Error: decision: question "q" is a choice question, which takes no levels.',
      ],
      [
        {
          type: "choice",
          instructions: "Which?",
          options: [{ value: "a" }, { value: "a" }],
        },
        'Error: decision: question "q" has the option "a" twice.',
      ],
    ];
    for (const [question, message] of cases)
      assert.equal(
        await refused({ input: TICKET, questions: { q: question } }, ALL_KEYS),
        message,
      );
    assert.equal(
      await refused({ questions: { q: yesNo } }, ALL_KEYS),
      "Error: decision: set input, images, or both.",
    );
    assert.equal(
      await refused({ input: TICKET, questions: { " ": yesNo } }, ALL_KEYS),
      "Error: decision: a question has no name.",
    );
    assert.equal(sent.length, 0);
  });

  it("refuses a value in another form than the one each input has", async () => {
    const sent = serve({});
    for (const input of [
      { input: TICKET, questions: {} },
      { input: "", questions: { q: yesNo } },
      { input: ["a"], questions: { q: yesNo } },
      {
        input: TICKET,
        questions: { q: { type: "predicate", instructions: "?" } },
      },
      { input: TICKET, questions: { q: { type: "yesNo" } } },
      {
        input: TICKET,
        questions: {
          q: { type: "choice", instructions: "?", options: [{ value: "a" }] },
        },
      },
      {
        input: TICKET,
        questions: {
          q: { type: "score", instructions: "?", levels: [{ label: "a" }] },
        },
      },
      { input: TICKET, images: [], questions: { q: yesNo } },
    ])
      assert.match(
        await refused(input, ALL_KEYS),
        /Invalid input for decision\.ask/,
        JSON.stringify(input),
      );
    assert.equal(sent.length, 0);
  });
});

describe("the action's description", () => {
  it("shows what a question takes, so code need not guess", async () => {
    const { result, error } = await harness
      .codemode(ALL_KEYS)
      .execute('return actions.describe("decision.ask")');
    assert.equal(error, undefined);
    const question = (
      result as {
        inputs: {
          questions: {
            values: { properties: Record<string, { enum?: string[] }> };
          };
        };
      }
    ).inputs.questions.values.properties;
    assert.deepEqual(Object.keys(question), [
      "type",
      "instructions",
      "options",
      "levels",
    ]);
    assert.deepEqual(question.type.enum, ["yesNo", "choice", "score"]);
  });
});

describe("a provider that fails", () => {
  const questions = { refund: QUESTIONS.refund };

  it("is reported by provider and status, without what it answered", async () => {
    serve({ detail: "the key KEY-typesafe is not valid" }, 401);
    assert.equal(
      await refused({ input: TICKET, questions }, through("typesafe")),
      "Error: decision.typesafe: request failed (HTTP 401)",
    );
  });

  it("is refused when it answers a question with nothing that reads", async () => {
    for (const [name, answer] of [
      ["openai", { answers: [] }],
      ["openai", { answers: [{ type: "choice", choice: "a", confidence: 1 }] }],
      ["typesafe", { answers: { refund: { type: "noul" } } }],
    ] as const) {
      serve(answer);
      assert.equal(
        await refused({ input: TICKET, questions }, through(name)),
        `Error: decision: ${name} answered nothing that reads for question "refund".`,
      );
    }
  });
});

describe("a provider a host adds", () => {
  const acme: DecisionProvider = {
    name: "acme",
    env: "ACME_DECISION_KEY",
    key: { header: "X-Acme-Key" },
    baseUrl: "https://decide.acme.example/",
    path: "ask",
    model: "acme-1",
    request: ({ model, input, questions }) => ({
      json: { model, input, ask: questions.map(({ name }) => name) },
    }),
    answers: (_response, { questions }) => ({
      model: "acme-1",
      answers: questions.map(() => ({ type: "yesNo", probability: 1 })),
    }),
  };
  const extended = pluginHarness(decision([acme, ...PROVIDERS]), "decision");

  it("is used like the others, with a key of its own", async () => {
    const sent = serve({});
    const { result, error } = await extended
      .codemode({ ...ALL_KEYS, acmeApiKey: "KEY-acme" })
      .execute(
        `return await decision.ask(${JSON.stringify({ input: TICKET, questions: { refund: QUESTIONS.refund } })})`,
      );
    assert.equal(error, undefined);
    assert.deepEqual(result, {
      provider: "acme",
      model: "acme-1",
      answers: { refund: { type: "yesNo", probability: 1 } },
    });
    assert.equal(sent[0].url, "https://decide.acme.example/ask");
    assert.equal(sent[0].headers["x-acme-key"], "KEY-acme");
    assert.ok(!JSON.stringify(sent).includes("KEY-openai"));
  });
});

describe("the README", () => {
  it("lists the providers in their order, with each key and default model", () => {
    const readme = readFileSync(join(PACKAGE, "README.md"), "utf8");
    const rows = [
      ...readme.matchAll(/^\| `(\w+)` \| `(\w+)` \| `([\w.-]+)` \|/gm),
    ].map(([, name, env, model]) => [name, env, model]);
    assert.deepEqual(
      rows,
      PROVIDERS.map(({ name, env, model }) => [name, env, model]),
    );
  });
});

describePackage(PACKAGE, {
  package: "@shiftlabs/codemode-decision",
  plugin: "decision",
  actions: 1,
  write: 0,
});
