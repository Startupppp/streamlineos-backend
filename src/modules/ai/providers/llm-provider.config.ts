export type LlmProviderName = "openai" | "openrouter";

export interface LlmProviderConfig {
  provider: LlmProviderName;
  apiKey: string | undefined;
  baseURL: string | undefined;
  fastModel: string;
  standardModel: string;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function resolveLlmProvider(): LlmProviderConfig {
  if (process.env.AI_LLM_PROVIDER === "openrouter") {
    return {
      provider: "openrouter",
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      fastModel: "openai/gpt-4o-mini",
      standardModel: "openai/gpt-4o",
    };
  }

  return {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: undefined,
    fastModel: "gpt-4o-mini",
    standardModel: "gpt-4o",
  };
}
