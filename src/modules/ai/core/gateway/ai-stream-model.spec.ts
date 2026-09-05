import { resolveAiStreamModel, selectTierModelId } from "./ai-stream-model";
import { resolveLlmProvider, type LlmProviderConfig } from "../providers/llm-provider.config";
import { resolveChatModelId } from "../services/chat-assistant-model";

describe("stream model tier selection", () => {
  it("preserves existing chat model selection when no tier is requested", () => {
    expect(resolveAiStreamModel(undefined).modelId).toBe(resolveChatModelId());
  });
  const config: LlmProviderConfig = {
    provider: "openai", apiKey: "test-only", baseURL: undefined,
    fastModel: "fast-alias", standardModel: "standard-alias",
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
