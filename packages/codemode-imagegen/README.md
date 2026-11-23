# codemode-imagegen

A [codemode](../../README.md) package with one plugin, `imagegen`, that makes and edits images through the image provider you have a key for.

Code calls `imagegen.create` and `imagegen.edit` the same way whichever provider answers, and gets files in one shape. Code never names a provider: the connection chooses it. Code can name a model, from the list `imagegen.models` returns.

## Install

Install the package and set the key of one provider:

```bash
codemode install npm:@shiftlabs/codemode-imagegen
export OPENAI_API_KEY=...
```

It needs a codemode newer than 0.46.0.

## Make an image

`imagegen.create` writes each image to a file and returns where it is:

```bash
codemode exec 'return await imagegen.create({ prompt: "a red bicycle on snow", width: 1536, height: 1024 })'
```

```json
{
  "provider": "openai",
  "model": "gpt-image-2.6-flare",
  "images": [
    {
      "path": "/tmp/imagegen-openai-3f9c2a1b7d4e5f60.png",
      "mimeType": "image/png",
      "byteLength": 1482113,
      "width": 1536,
      "height": 1024
    }
  ]
}
```

| Input | Form | Meaning |
|---|---|---|
| `prompt` | Text | What the image shows |
| `model` | An id from `imagegen.models` | The model to use. The default is the connection's |
| `width`, `height` | Whole numbers from 256 to 4096, set together | The size in pixels. Without them, the model's own size |
| `numImages` | A whole number from 1 to 4 | How many images to make. The default is 1 |

The files are in the host's [output directory](../../docs/sdk.md#limit-a-runs-result), or the system's temporary directory. Codemode never deletes them.

## Edit an image

`imagegen.edit` takes the same inputs and the paths of the images to work from:

```js
await imagegen.edit({
  prompt: "make it night, with the street lamps lit",
  images: ["/data/street.png"],
});
```

`images` is 1 to 8 paths of PNG, JPEG, or WebP files. What a file is, its bytes say: one that is none of these is refused, whatever its name. Some models take one image, and a call that passes more is refused.

## Choose a model

`imagegen.models` lists the models the connection's provider has, what each can do, and the model each action uses when a call names none:

```js
const { models, createModel, editModel } = await imagegen.models({ query: "vector" });
// models: [{ id: "recraftv4_1_vector", create: true, edit: true }, ...]
await imagegen.create({ prompt: "a rocket logo", model: models[0].id });
```

| Input | Meaning |
|---|---|
| `query` | Words to find models by |
| `limit` | The most models to return, from 1 to 200. The default is 50 |

A call that names a model is checked against the provider's models before anything is made. A model the provider does not have, or one that cannot do what the action does, is refused.

The list is the models this package knows of with the provider's own list laid over them. Codemode asks the provider once and keeps the answer for ten minutes. fal and Replicate host thousands of models: without `query` the list is their best-known ones, and with `query` it is what their search finds. Any image model of theirs can be named, listed or not.

## Set a size

`width` and `height` are pixels, for every provider. A model that takes other sizes makes the nearest one it can, and each image in the result says the size it came out at:

| Provider | What a size becomes |
|---|---|
| `openai` | The same pixels, with sides rounded to 16 and the longer side at most three times the shorter |
| `google` | The nearest aspect ratio |
| `xai` | The nearest aspect ratio, and a resolution of 1k, 1.5k, or 2k |
| `recraft` | The nearest aspect ratio |
| `together` | The same pixels, with sides rounded to 16 and kept from 256 to 1920 |
| `fal`, `replicate` | What the model's own schema takes: pixels, or the nearest of its sizes or aspect ratios |

A model with no size input refuses a call that sets one.

## Choose a provider

The connection chooses the provider, and no action has an input for it. A request goes to the connection's `provider` when it names one, else to the first provider in this table that has a key:

| Provider | Key | Lists its models | Models |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | Yes | GPT Image |
| `google` | `GOOGLE_API_KEY` | Yes | Gemini image models (Nano Banana) |
| `xai` | `XAI_API_KEY` | Yes | Grok Imagine |
| `recraft` | `RECRAFT_API_KEY` | No | Recraft raster and vector models |
| `together` | `TOGETHER_API_KEY` | Yes | FLUX and others it hosts |
| `fal` | `FAL_KEY` | Yes | Any image model fal hosts |
| `replicate` | `REPLICATE_API_TOKEN` | Yes | Any image model Replicate hosts |

The result's `provider` and `model` say which answered.

## Configure the connection

Add a connection to keep keys in codemode, or to choose the provider and its models. Every field is optional:

```bash
codemode connection add imagegen --plugin imagegen --set provider=google --set createModel=gemini-3-pro-image
```

| Field | Meaning |
|---|---|
| `provider` | The provider every request goes to. The default is the first with a key |
| `createModel`, `editModel` | The model each action uses when a call names none. The default is the provider's |
| `<provider>ApiKey` | The provider's key, such as `openaiApiKey`. The default is its environment variable |

Each key is declared with the addresses that may receive it. A request to one provider sends no other provider's key, and an image a provider hands over as a link is fetched without any key.

## Add a provider

A host that embeds codemode builds the plugin from its own list of providers. A provider is its key's place in a request, the addresses that may receive the key, the models it has, and a function that makes the images of one request:

```typescript
import { Codemode } from "@shiftlabs/codemode";
import { type ImageProvider, imagegen, PROVIDERS } from "@shiftlabs/codemode-imagegen";

const acme: ImageProvider = {
  name: "acme",
  env: "ACME_IMAGE_KEY",
  key: { header: "X-Acme-Key" },
  targets: { acme: { baseUrl: "https://images.acme.example/", methods: ["POST"] } },
  defaults: { create: "acme-1" },
  models: [{ id: "acme-1", create: true, edit: false }],
  generate: async (api, { prompt, model, numImages, size }) => {
    const { images } = await api.request<{ images: string[] }>({
      path: "make",
      method: "POST",
      json: { prompt, model: model.id, count: numImages, ...size },
    });
    return images.map((base64) => ({ base64 }));
  },
};

const codemode = Codemode.create({ plugins: [imagegen([acme, ...PROVIDERS])] });
```

The list's order is the order a provider is chosen in. A provider that lists its models over its API adds `listModels`. The package is TypeScript source, so the host imports it with a runtime that runs TypeScript, such as Bun.

## Handle failures

| Outcome | Result |
|---|---|
| No provider has a key | The call rejects and names the environment variables |
| A file in `images` is not a PNG, JPEG, or WebP image | The call rejects before anything is made |
| The provider has no such model, or the model cannot do what the action does | The call rejects and points to `imagegen.models` |
| The model has no input for the size, the count, or the images a call sets | The call rejects and says what to leave out |
| The provider refuses the request | The call rejects with `imagegen.<provider>: request failed (HTTP <status>)` |
| The model answers no image | The call rejects. The provider may have refused the prompt |
| A queued request on fal or Replicate runs past five minutes | The call rejects and names the request, which is not cancelled |

A provider's error text is not included in the message, because it can repeat the key it was sent.

## Understand the limits

- `create` and `edit` are labelled `write`: each call is billed by the provider and writes files.
- A provider whose models could not be listed judges a model id itself.
- Google's models answer one image a request, so `numImages` is that many requests.
- Recraft keeps the size of an image it edits, and edits one image.
- An image is fetched from fal's and Replicate's own file hosts only.
- On Replicate, an image to edit is uploaded as a file first, which Replicate keeps until it expires. On fal it is sent inside the request, which fal recommends for small files only.
- A request to a provider is not ended when the run ends.
- The bundled `openai`, `googleImage`, `xai`, `recraft`, `together`, `fal`, and `replicate` plugins are separate from this package, each with its own connection.
