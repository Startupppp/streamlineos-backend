export interface ModelTokenPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

export const AI_MARGIN = 1.5;
export const CREDIT_USD_VALUE = 0.01;
export const MIN_CHARGE_MILLI = 10;

function normalizeModelId(model: string): string {
  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1) {
    return model.slice(slashIdx + 1);
  }
  return model;
}

const MODEL_TOKEN_PRICING_RAW: Record<string, ModelTokenPricing> = {
  DEFAULT: { inputUsdPer1M: 0.5, outputUsdPer1M: 1.5 },
  "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10.0 },
  "gpt-3.5-turbo": { inputUsdPer1M: 0.5, outputUsdPer1M: 1.5 },
  "gemini-1.5-pro": { inputUsdPer1M: 1.25, outputUsdPer1M: 5.0 },
  "gemini-1.5-pro-latest": { inputUsdPer1M: 1.25, outputUsdPer1M: 5.0 },
  "gemini-1.5-flash": { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3 },
  "gemini-1.5-flash-latest": { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3 },
};

export const MODEL_TOKEN_PRICING: Readonly<Record<string, ModelTokenPricing>> = MODEL_TOKEN_PRICING_RAW;

function lookupPricing(model: string): ModelTokenPricing {
  const normalized = normalizeModelId(model);
  return MODEL_TOKEN_PRICING_RAW[normalized] ?? MODEL_TOKEN_PRICING_RAW["DEFAULT"]!;
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
