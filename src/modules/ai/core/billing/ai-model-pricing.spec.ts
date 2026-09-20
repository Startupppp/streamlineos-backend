import { resolveLlmProvider } from "../providers/llm-provider.config";
import {
  AI_MODEL_CATALOG,
  computeTokenCharge,
  isKnownChatModelId,
  KNOWN_CHAT_MODEL_IDS,
  MIN_CHARGE_MILLI,
} from "./ai-model-pricing.constants";

describe("AI model catalog integrity", () => {
  it("every hardcoded default chain model resolves a catalog entry — an absent entry silently bills at the fallback rate instead of the model's actual cost", () => {
    const config = resolveLlmProvider({});
    const hardcodedDefaults = [config.fastModel, config.standardModel];
    for (const modelId of hardcodedDefaults) {
      const normalized = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
      expect(Object.hasOwn(AI_MODEL_CATALOG, normalized)).toBe(true);
    }
  });

  it("every model id in KNOWN_CHAT_MODEL_IDS resolves a catalog entry — an absent entry bills wrong and isKnownChatModelId passes a model with no pricing", () => {
    for (const modelId of KNOWN_CHAT_MODEL_IDS) {
      expect(Object.hasOwn(AI_MODEL_CATALOG, modelId)).toBe(true);
    }
  });

  it("computeTokenCharge returns MIN_CHARGE_MILLI for zero token calls regardless of model", () => {
    expect(computeTokenCharge("gpt-4o-mini", 0, 0).milliCredits).toBe(MIN_CHARGE_MILLI);
    expect(computeTokenCharge("gemini-2.5-pro", 0, 0).milliCredits).toBe(MIN_CHARGE_MILLI);
  });

  it("isKnownChatModelId accepts bare and provider-prefixed forms of the same model", () => {
    expect(isKnownChatModelId("gpt-4o-mini")).toBe(true);
    expect(isKnownChatModelId("openai/gpt-4o-mini")).toBe(true);
    expect(isKnownChatModelId("text-embedding-3-small")).toBe(false);
    expect(isKnownChatModelId("not-a-real-model")).toBe(false);
  });
});
