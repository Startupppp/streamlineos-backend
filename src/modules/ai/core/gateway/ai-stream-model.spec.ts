import {
  DEFAULT_STREAM_GOOGLE_MODEL,
  resolveAiStreamModel,
  selectTierModelId,
} from "./ai-stream-model";
import { withUsageMeta } from "./ai-gateway-runner-call";
import { resolveLlmProvider, type LlmProviderConfig } from "../providers/llm-provider.config";
import { resolveChatModelId } from "../services/chat-assistant-model";

describe("stream model tier selection", () => {
  it("holds the untiered default independently, so a chat model change cannot repoint the 21 untiered callers", () => {
    expect(resolveAiStreamModel(undefined).modelId).toBe(DEFAULT_STREAM_GOOGLE_MODEL);
    expect(resolveAiStreamModel(undefined).modelId).not.toBe(resolveChatModelId());
  });
  const config: LlmProviderConfig = {
    provider: "openai", apiKey: "test-only", baseURL: undefined,
    fastChain: ["configured-fast-primary", "configured-fast-fallback"],
    standardChain: ["configured-standard-primary", "configured-standard-fallback"],
  };

  it("uses the configured first fast model for explicit fast streams", () => {
    expect(selectTierModelId(config, "fast")).toBe("configured-fast-primary");
  });

  it("uses the configured first standard model for explicit standard streams", () => {
    expect(selectTierModelId(config, "standard")).toBe("configured-standard-primary");
  });

  it.each(["openai", "openrouter"])("matches the buffered LLM chain for %s", (provider) => {
    const resolved = resolveLlmProvider({ AI_LLM_PROVIDER: provider });
    expect(selectTierModelId(resolved, "fast")).toBe(resolved.fastChain[0]);
    expect(selectTierModelId(resolved, "standard")).toBe(resolved.standardChain[0]);
  });

  it("refuses an empty explicit tier instead of silently switching to chat", () => {
    expect(() => selectTierModelId({ ...config, fastChain: [] }, "fast")).toThrow("tier is not configured");
  });
});

describe("withUsageMeta carries the provider so the AI ledger is not written with a null", () => {
  function success(model: string) {
    return {
      ok: true as const,
      data: null,
      model,
      latencyMs: 1,
      correlationId: "corr-1",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }

  it("reports openrouter for a slash-prefixed model and openai for a bare one", () => {
    const viaOpenRouter = withUsageMeta(success("openai/gpt-4o"));
    const viaOpenAi = withUsageMeta(success("gpt-4o"));

    expect(viaOpenRouter.ok && viaOpenRouter.aiUsage.provider).toBe("openrouter");
    expect(viaOpenAi.ok && viaOpenAi.aiUsage.provider).toBe("openai");
  });

  it("never leaves the provider undefined on a successful call, which is what made every research brief report a null provider", () => {
    const result = withUsageMeta(success("gemini-2.5-pro"));

    expect(result.ok && result.aiUsage.provider).toBeDefined();
    expect(result.ok && result.aiUsage.provider).toBe("google");
  });
});
