import { logger } from "../../../../common/logger/logger.service";

export interface ModelTokenPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

export const AI_MARGIN = 1.5;
export const CREDIT_USD_VALUE = 0.01;
export const MIN_CHARGE_MILLI = 10;

function normalizeModelId(model: string): string {
  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1) return model.slice(slashIdx + 1);
  return model;
}

const DEFAULT_PRICING: ModelTokenPricing = { inputUsdPer1M: 0.5, outputUsdPer1M: 1.5 };

export const AI_MODEL_CATALOG = {
  "text-embedding-3-small":  { inputUsdPer1M: 0.02,  outputUsdPer1M: 0.0  },
  "gpt-4o-mini":             { inputUsdPer1M: 0.15,  outputUsdPer1M: 0.6  },
  "gpt-4o":                  { inputUsdPer1M: 2.5,   outputUsdPer1M: 10.0 },
  "gpt-3.5-turbo":           { inputUsdPer1M: 0.5,   outputUsdPer1M: 1.5  },
  "gemini-1.5-pro":          { inputUsdPer1M: 1.25,  outputUsdPer1M: 5.0  },
  "gemini-1.5-pro-latest":   { inputUsdPer1M: 1.25,  outputUsdPer1M: 5.0  },
  "gemini-1.5-flash":        { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3  },
  "gemini-1.5-flash-latest": { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3  },
  "gemini-2.5-pro":          { inputUsdPer1M: 1.25,  outputUsdPer1M: 10.0 },
  "gemini-2.5-flash":        { inputUsdPer1M: 0.3,   outputUsdPer1M: 2.5  },
  "gemini-2.0-flash":        { inputUsdPer1M: 0.1,   outputUsdPer1M: 0.4  },
} satisfies Record<string, ModelTokenPricing>;

export type PricedModelId = keyof typeof AI_MODEL_CATALOG;

export type ProviderModelId = PricedModelId | `${string}/${PricedModelId}`;

const KNOWN_CHAT_MODEL_KEYS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-3.5-turbo",
  "gemini-1.5-pro",
  "gemini-1.5-pro-latest",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
] as const satisfies readonly PricedModelId[];

export const KNOWN_CHAT_MODEL_IDS: ReadonlySet<string> = new Set<string>(KNOWN_CHAT_MODEL_KEYS);

export function isKnownChatModelId(model: string): boolean {
  return KNOWN_CHAT_MODEL_IDS.has(normalizeModelId(model));
}

export const GOOGLE_MODEL_ID_PREFIX = "gemini-";

export function providerOfModelId(model: string): string {
  if (model.includes("/")) return "openrouter";
  if (model.startsWith(GOOGLE_MODEL_ID_PREFIX)) return "google";
  return "openai";
}

function hasCatalogEntry(id: string): id is PricedModelId {
  return Object.hasOwn(AI_MODEL_CATALOG, id);
}

function lookupPricing(model: string): ModelTokenPricing {
  const normalized = normalizeModelId(model);
  if (hasCatalogEntry(normalized)) return AI_MODEL_CATALOG[normalized];
  logger.warn("AI model has no pricing entry; billing at the DEFAULT rate", {
    model,
    normalized,
  });
  return DEFAULT_PRICING;
}

export function computeTokenCharge(
  model: string,
  promptTokens: number,
  completionTokens: number,
): { costUsd: number; milliCredits: number } {
  const pricing = lookupPricing(model);
  const costUsd =
    (promptTokens * pricing.inputUsdPer1M + completionTokens * pricing.outputUsdPer1M) / 1_000_000;
  const milliCredits = Math.max(
    MIN_CHARGE_MILLI,
    Math.round((costUsd * AI_MARGIN) / CREDIT_USD_VALUE * 1000),
  );
  return { costUsd, milliCredits };
}

export function creditsToMilli(credits: number): number {
  return Math.round(credits * 1000);
}

export function milliToCredits(milli: number): number {
  return Math.round(milli) / 1000;
}
