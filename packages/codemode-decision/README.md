# codemode-decision

A [codemode](../../README.md) package with one plugin, `decision`, that asks a decision model questions through the provider you have a key for.

A decision model returns typed answers with probabilities instead of text: how likely a yes, one of a set of options, or a place on a scale. It answers much faster than a chat model, for classifying, routing and scoring inside code. Code calls `decision.ask` the same way whichever provider answers, and never names a provider: the connection chooses it.

## Install

Install the package and set the key of one provider:

```bash
codemode install npm:@shiftlabs/codemode-decision
export OPENAI_API_KEY=...
```

It needs a codemode newer than 0.46.0.

## Ask questions

`decision.ask` takes the evidence as `input` and the questions under names you choose, and returns an answer under each name:

```bash
codemode exec 'return await decision.ask({
  input: "I was charged twice for my order. Please refund one.",
  questions: {
    refund: { type: "yesNo", instructions: "Does the customer ask for a refund?" },
    department: {
      type: "choice",
      instructions: "Which department should handle this?",
      options: [
        { value: "billing", description: "Payments, invoices and refunds." },
        { value: "technical", description: "Problems using the product." },
        { value: "other", description: "Anything else." },
      ],
    },
    severity: {
      type: "score",
      instructions: "How severe is this for the customer?",
      levels: [
        { label: "Minor", description: "An annoyance; nothing is lost." },
        { label: "Costly", description: "Money or time is lost." },
        { label: "Blocked", description: "The customer cannot use the product." },
      ],
    },
  },
})'
```

```json
{
  "provider": "openai",
  "model": "gpt-6-luna",
  "inputTokens": 96,
  "answers": {
    "refund": { "type": "yesNo", "probability": 0.97 },
    "department": {
      "type": "choice",
      "choice": "billing",
      "confidence": 0.93,
      "probabilities": [
        { "value": "billing", "probability": 0.95 },
        { "value": "technical", "probability": 0.02 },
        { "value": "other", "probability": 0.03 }
      ]
    },
    "severity": {
      "type": "score",
      "score": 1.1,
      "confidence": 0.55,
      "probabilities": [
        { "level": 0, "label": "Minor", "probability": 0.1 },
        { "level": 1, "label": "Costly", "probability": 0.7 },
        { "level": 2, "label": "Blocked", "probability": 0.2 }
      ]
    }
  }
}
```

| Input | Form | Meaning |
|---|---|---|
| `input` | Text, or a JSON object | What every question is about. Needed unless `images` is set |
| `images` | 1 to 8 paths of PNG or JPEG files | Images that are part of what every question is about |
| `questions` | An object of 1 to 400 questions | Each question, under the name its answer comes back under |

Every question is answered on its own: one answer is no input to another. Ask a question that depends on an answer in a second call.

## Choose a question type

Each question has a `type` and `instructions`, which say what to decide:

| Type | Also takes | Answer |
|---|---|---|
| `yesNo` | Nothing | `probability`: how likely the answer is yes, from 0 to 1 |
| `choice` | `options`: 2 to 255 of `{ value, description? }`, with different values | `choice`: one option's value, with `confidence` and every option's probability |
| `score` | `levels`: 2 to 10 of `{ label, description? }`, from the lowest to the highest | `score`: the probability-weighted average of the levels' positions, from 0, with `confidence` and every level's probability |

A `score` can fall between levels: 1.1 is a little above the second level. Use `choice` for options with no order.

A model can decline a question. Its answer is then `{ "type": "refusal" }`, and the other questions are still answered.

## Act on an answer

Compare a probability with a threshold you choose, by what a wrong answer costs:

```js
const { answers } = await decision.ask({ input: ticket, questions });
if (answers.refund.type === "yesNo" && answers.refund.probability > 0.7) await refund(ticket);
if (answers.department.type === "choice" && answers.department.confidence < 0.5) await review(ticket);
```

`confidence` is the provider's own summary of how settled a `choice` or `score` answer is, from 0 to 1. Each provider calculates it its own way, so tune a threshold against the provider and model the connection uses, and keep to them.

## Send images

`images` takes paths of image files on the codemode host. They are part of the evidence, beside `input` or in place of it:

```js
await decision.ask({
  input: "A photo of a returned product.",
  images: ["/data/returns/4471.jpg"],
  questions: { damaged: { type: "yesNo", instructions: "Is the product in the image visibly damaged?" } },
});
```

What a file is, its bytes say: one that is no PNG or JPEG is refused, whatever its name. A file is at most 16 MiB.

## Choose a provider

The connection chooses the provider, and the action has no input for it. A request goes to the connection's `provider` when it names one, else to the first provider in this table that has a key:

| Provider | Key | Default model | Images |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | `gpt-6-luna` | No bounds documented |
| `typesafe` | `TYPESAFE_API_KEY` | `jev-latest` | Each side from 280 to 1568 pixels |

The result's `provider` and `model` say which answered. `model` is the version that answered, which can differ from an alias such as `jev-latest`.

## Configure the connection

Add a connection to keep keys in codemode, or to choose the provider and its model. Every field is optional:

```bash
codemode connection add decision --plugin decision --set provider=typesafe --set model=jev-1.14.0
```

| Field | Meaning |
|---|---|
| `provider` | The provider every request goes to. The default is the first with a key |
| `model` | The model every request uses. The default is the provider's |
| `<provider>ApiKey` | The provider's key, such as `openaiApiKey`. The default is its environment variable |

An alias moves to a new version when one is released, and answers can change with it. Set `model` to a version once thresholds are tuned against it.

Each key is declared with the one address that may receive it. A request to one provider sends no other provider's key.

## Add a provider

A host that embeds codemode builds the plugin from its own list of providers. A provider is its key's place in a request, its address, its default model, and two functions: the request a decision becomes, and the answers in its response, in the questions' order:

```typescript
import { Codemode } from "@shiftlabs/codemode";
import { type DecisionProvider, decision, PROVIDERS } from "@shiftlabs/codemode-decision";

const acme: DecisionProvider = {
  name: "acme",
  env: "ACME_DECISION_KEY",
  key: { header: "X-Acme-Key" },
  baseUrl: "https://decide.acme.example/",
  path: "ask",
  model: "acme-1",
  request: ({ model, input, questions }) => ({ json: { model, input, questions } }),
  answers: (response, { questions }) => ({
    model: "acme-1",
    answers: questions.map(({ name }) => ({
      type: "yesNo",
      probability: (response as Record<string, number>)[name],
    })),
  }),
};

const codemode = Codemode.create({ plugins: [decision([acme, ...PROVIDERS])] });
```

The list's order is the order a provider is chosen in. The package is TypeScript source, so the host imports it with a runtime that runs TypeScript, such as Bun.

## Handle failures

| Outcome | Result |
|---|---|
| No provider has a key | The call rejects and names the environment variables |
| A question has fields that are not its type's, or two options with one value | The call rejects and names the question |
| A file in `images` is not a PNG or JPEG image, or is a size the provider does not take | The call rejects before any request is made |
| The provider refuses the request | The call rejects with `decision.<provider>: request failed (HTTP <status>)` |
| The provider answers a question with nothing that reads | The call rejects and names the question |
| The model declines a question | The call resolves, and that answer is `{ "type": "refusal" }` |

A provider's error text is not included in the message, because it can repeat the key it was sent.

## Understand the limits

- The action has what both providers do. Locating something in an image, a conversation as input, and an image inside one question are not in it.
- The bundled `typesafe` plugin is separate from this package, with its own connection. It reaches what only TypeSafe has.
- TypeSafe calls its image input not yet ready for production. A request with images turns it on.
- A request that is too long for the model is refused by the provider. TypeSafe's long context is not turned on.
- A request is not retried. A provider that is over its rate limit answers HTTP 429.
- A request to a provider is not ended when the run ends.
