import type { ProviderModelId } from "../billing/ai-model-pricing.constants";

export type LlmProviderName = "openai" | "openrouter";

export interface LlmProviderConfig {
  provider: LlmProviderName;
  apiKey: string | undefined;
  baseURL: string | undefined;
  fastChain: string[];
  standardChain: string[];
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function parseModelList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildChain(primary: string, override: string | undefined, lastResort: string): string[] {
  const configured = parseModelList(override);
  const candidates = configured.length > 0 ? [primary, ...configured] : [primary, lastResort];
  return [...new Set(candidates)];
}

export function resolveLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProviderConfig {
  const isOpenRouter = env.AI_LLM_PROVIDER === "openrouter";

  const fastModel: ProviderModelId = isOpenRouter ? "openai/gpt-4o-mini" : "gpt-4o-mini";
  const standardModel: ProviderModelId = isOpenRouter ? "openai/gpt-4o" : "gpt-4o";

  return {
    provider: isOpenRouter ? "openrouter" : "openai",
    apiKey: isOpenRouter ? env.OPENROUTER_API_KEY : env.OPENAI_API_KEY,
    baseURL: isOpenRouter ? OPENROUTER_BASE_URL : undefined,
    fastChain: buildChain(fastModel, env.AI_FAST_FALLBACK_MODELS, standardModel),
    standardChain: buildChain(standardModel, env.AI_STANDARD_FALLBACK_MODELS, fastModel),
  };
}
