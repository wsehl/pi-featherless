/**
 * Featherless.ai provider for pi.
 *
 * Log in with `/login featherless` (the key is stored in ~/.pi/agent/auth.json),
 * or set FEATHERLESS_API_KEY.
 *
 * Pi refreshes extension providers cache-only at startup, and `pi update --models`
 * does not load extensions. So the catalog is persisted to models-store.json and
 * this extension starts its own network refresh on session start when it is stale.
 */
import {
  hasApi,
  type AnyModel,
  type Model,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const PROVIDER = "featherless";
const BASE_URL = "https://api.featherless.ai/v1";
const ENV_KEY = "FEATHERLESS_API_KEY";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 30_000;
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;
// Stored in the cache's etag slot (this provider never sends it back). Bump it when
// toPiModel changes, so cached catalogs in the old shape are refetched immediately.
const CATALOG_FORMAT = "pi-featherless/2";

// Featherless rejects requests without a User-Agent, and Node's fetch sends none.
const HEADERS = { "User-Agent": "pi-featherless/1.0" };

const OptionalNumber = Type.Optional(Type.Union([Type.Number(), Type.Null()]));
const OptionalBoolean = Type.Optional(Type.Union([Type.Boolean(), Type.Null()]));

// Only the fields this provider reads. Other catalog fields are ignored.
const CatalogEntry = Type.Object({
  id: Type.String({ minLength: 1 }),
  model_class: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  context_length: OptionalNumber,
  max_completion_tokens: OptionalNumber,
  pricing: Type.Optional(
    Type.Union([Type.Object({ input: OptionalNumber, output: OptionalNumber }), Type.Null()]),
  ),
  features: Type.Optional(Type.Union([Type.Object({ image_input: OptionalBoolean }), Type.Null()])),
});

const CatalogResponse = Type.Object({ data: Type.Array(Type.Unknown()) });

type CatalogEntry = Static<typeof CatalogEntry>;

function positiveOr(value: number | null | undefined, fallback: number): number {
  return value !== undefined && value !== null && value > 0 ? value : fallback;
}

// Qwen3-family chat templates (Qwen3, 3.5, 3.6, ...) think by default and read
// chat_template_kwargs.enable_thinking. Embedding, TTS, and Coder variants do not think.
function hasQwenThinking(modelClass: string | null | undefined): boolean {
  return (
    modelClass !== undefined &&
    modelClass !== null &&
    /^qwen3/i.test(modelClass) &&
    !/embedding|tts|coder/i.test(modelClass)
  );
}

function toPiModel(entry: CatalogEntry): Model<"openai-completions"> {
  const contextWindow = positiveOr(entry.context_length, DEFAULT_CONTEXT_WINDOW);

  const maxTokens = positiveOr(
    entry.max_completion_tokens,
    Math.min(DEFAULT_MAX_TOKENS, contextWindow),
  );

  // Without this, thinking stays on even at thinking level "off" and uses up the output budget.
  const reasoning = hasQwenThinking(entry.model_class);

  return {
    id: entry.id,
    name: entry.id,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: BASE_URL,
    headers: HEADERS,
    reasoning,
    input: entry.features?.image_input === true ? ["text", "image"] : ["text"],
    cost: {
      input: entry.pricing?.input ?? 0,
      output: entry.pricing?.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      ...(reasoning ? { thinkingFormat: "qwen-chat-template" as const } : {}),
    },
  };
}

type PayloadOptions = {
  maxTokens?: number;
  onPayload?: (payload: unknown, model: Model<"openai-completions">) => unknown;
};

/**
 * Pi caps max_tokens at the context window minus a character-based prompt estimate.
 * That estimate counts old thinking, which the chat template drops, so after compaction
 * it can leave almost no room (down to max_tokens=1) and every reply is truncated.
 * Featherless rejects prompt + max_tokens above the context size, and when max_tokens
 * is omitted it allows the rest of the context. So let the server size the output
 * unless the caller asked for a specific limit.
 */
function serverSizedOutput<T extends PayloadOptions>(options: T | undefined): T | undefined {
  if (options?.maxTokens !== undefined) {
    return options;
  }

  const onPayload = options?.onPayload;

  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<"openai-completions">) => {
      let next = payload;

      if (typeof payload === "object" && payload !== null && "max_tokens" in payload) {
        const { max_tokens: _omitted, ...rest } = payload;
        next = rest;
      }

      return (await onPayload?.(next, model)) ?? next;
    },
  } as T;
}

async function fetchCatalog(signal: AbortSignal): Promise<Model<"openai-completions">[]> {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { Accept: "application/json", ...HEADERS },
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Featherless model discovery failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload: unknown = await response.json();

  if (!Value.Check(CatalogResponse, payload)) {
    throw new Error("Featherless returned an invalid model list");
  }

  // Skip malformed entries instead of rejecting the whole catalog.
  return payload.data.flatMap((entry) =>
    Value.Check(CatalogEntry, entry) ? [toPiModel(entry)] : [],
  );
}

function isFeatherlessModel(model: AnyModel): model is Model<"openai-completions"> {
  return model.provider === PROVIDER && hasApi(model, "openai-completions");
}

function createFeatherlessProvider(): Provider<"openai-completions"> {
  const streams = openAICompletionsApi();
  let models: Model<"openai-completions">[] = [];

  async function refreshModels(context: RefreshModelsContext): Promise<void> {
    const stored = context.stored;

    if (stored) {
      const restored = stored.models.filter(isFeatherlessModel);

      const published = await context.publish({
        update: () => {
          models = restored;
        },
      });

      if (!published) {
        return;
      }
    }

    if (!context.allowNetwork || context.signal.aborted) {
      return;
    }

    const fresh =
      stored?.etag === CATALOG_FORMAT &&
      stored.checkedAt !== undefined &&
      Date.now() - stored.checkedAt < REFRESH_INTERVAL_MS;

    if (fresh && !context.force && models.length > 0) {
      return;
    }

    const refreshed = await fetchCatalog(context.signal);

    if (context.signal.aborted) {
      return;
    }

    await context.publish({
      persist: { models: refreshed, checkedAt: Date.now(), etag: CATALOG_FORMAT },
      update: () => {
        models = refreshed;
      },
    });
  }

  return {
    id: PROVIDER,
    name: "Featherless.ai",
    baseUrl: BASE_URL,
    headers: HEADERS,
    auth: {
      apiKey: {
        name: "Featherless API key",
        async login(interaction) {
          const key = (
            await interaction.prompt({ type: "secret", message: "Featherless API key" })
          ).trim();

          if (!key) {
            throw new Error("An API key is required");
          }

          return { type: "api_key", key };
        },
        async resolve({ credential, ctx }) {
          if (credential?.key) {
            return { auth: { apiKey: credential.key }, source: "stored API key" };
          }

          const key = await ctx.env(ENV_KEY);

          return key ? { auth: { apiKey: key }, source: ENV_KEY } : undefined;
        },
      },
    },
    getModels: () => models,
    refreshModels,
    stream: (model, context, options) => streams.stream(model, context, serverSizedOutput(options)),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, serverSizedOutput(options)),
  };
}

export default function featherless(pi: ExtensionAPI): void {
  pi.registerProvider(createFeatherlessProvider());

  // Background network refresh; refreshModels skips the request while the cache is fresh.
  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_OFFLINE !== undefined) {
      return;
    }

    const signal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    void ctx.modelRegistry
      .refresh({ providers: [PROVIDER], allowNetwork: true, signal })
      .then((result) => {
        const error = result.errors.get(PROVIDER);

        if (error && ctx.hasUI) {
          ctx.ui.notify(`Featherless: ${error.message}`, "warning");
        }
      });
  });

  // Featherless reports overflow as "... exceeds the maximum context length limit ...",
  // which pi does not recognise. Normalise it so pi can compact and retry.
  pi.on("message_end", (event) => {
    const message = event.message;

    if (
      message.role !== "assistant" ||
      message.stopReason !== "error" ||
      message.provider !== PROVIDER
    ) {
      return;
    }

    const errorMessage = message.errorMessage ?? "";

    if (errorMessage.includes("context_length_exceeded")) {
      return;
    }

    if (!/exceeds the maximum context length limit/i.test(errorMessage)) {
      return;
    }

    return { message: { ...message, errorMessage: `context_length_exceeded: ${errorMessage}` } };
  });
}
