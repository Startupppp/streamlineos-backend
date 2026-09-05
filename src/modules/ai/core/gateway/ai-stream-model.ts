import { ServiceUnavailableException } from "@nestjs/common";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { resolveLlmProvider, type LlmProviderConfig } from "../providers/llm-provider.config";
import { resolveChatModel, resolveChatModelId } from "../services/chat-assistant-model";
import type { AiInvokeBaseOpts } from "./ai-gateway.types";

export function selectTierModelId(config: LlmProviderConfig, tier: "fast" | "standard"): string {
  const modelId = (tier === "fast" ? config.fastChain : config.standardChain)[0];
  if (!modelId) throw new ServiceUnavailableException("AI model tier is not configured");
  return modelId;
}

export function resolveAiStreamModel(tier: AiInvokeBaseOpts["tier"]): { modelId: string; model: LanguageModel } {
  if (tier === undefined) return { modelId: resolveChatModelId(), model: resolveChatModel() };
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
