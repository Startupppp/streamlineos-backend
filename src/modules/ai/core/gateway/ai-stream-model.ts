import { ServiceUnavailableException } from "@nestjs/common";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { resolveLlmProvider, type LlmProviderConfig } from "../providers/llm-provider.config";
import type { ProviderModelId } from "../billing/ai-model-pricing.constants";
import type { AiInvokeBaseOpts } from "./ai-gateway.types";

export const DEFAULT_STREAM_GOOGLE_MODEL: ProviderModelId = "gemini-1.5-pro-latest";
export const DEFAULT_STREAM_OPENROUTER_MODEL: ProviderModelId = "openai/gpt-4o";

export function resolveDefaultStreamModelId(): string {
  return process.env.AI_CHAT_PROVIDER === "openrouter"
    ? DEFAULT_STREAM_OPENROUTER_MODEL
    : DEFAULT_STREAM_GOOGLE_MODEL;
}

export function resolveDefaultStreamModel(): LanguageModel {
  if (process.env.AI_CHAT_PROVIDER === "openrouter") {
    return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).chat(
      DEFAULT_STREAM_OPENROUTER_MODEL,
    );
  }
  return google(DEFAULT_STREAM_GOOGLE_MODEL);
}

export function selectTierModelId(config: LlmProviderConfig, tier: "fast" | "standard"): string {
  const modelId = (tier === "fast" ? config.fastChain : config.standardChain)[0];
  if (!modelId) throw new ServiceUnavailableException("AI model tier is not configured");
  return modelId;
}

export function resolveAiStreamModel(tier: AiInvokeBaseOpts["tier"]): { modelId: string; model: LanguageModel } {
  if (tier === undefined)
    return { modelId: resolveDefaultStreamModelId(), model: resolveDefaultStreamModel() };
  const config = resolveLlmProvider();
  if (!config.apiKey) throw new ServiceUnavailableException("AI provider is not configured");
  const modelId = selectTierModelId(config, tier);
  const provider = createOpenRouter({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? "https://api.openai.com/v1",
    compatibility: "strict",
  });
  return { modelId, model: provider.chat(modelId) };
}
