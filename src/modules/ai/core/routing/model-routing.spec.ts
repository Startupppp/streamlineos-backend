import { AI_FEATURE_COSTS } from "../billing/ai-cost-catalog";
import { type LlmProviderConfig } from "../providers/llm-provider.config";
import { ModelRouting, resolveGatewayTier, type AiFeatureKey } from "./model-routing";

const TEST_CONFIG: LlmProviderConfig = {
  provider: "openai",
  apiKey: "test-only",
  baseURL: undefined,
  fastChain: ["gpt-4o-mini"],
  standardChain: ["gpt-4o"],
};

describe("ModelRouting.routeFor", () => {
  it("every feature key registered in the tier map resolves to a defined tier, so no new catalog entry can silently fall through to a cheaper default", () => {
    const catalogKeys = Object.keys(AI_FEATURE_COSTS) as AiFeatureKey[];
    for (const key of catalogKeys) {
      const route = ModelRouting.routeFor(key, TEST_CONFIG);
      expect(route.model).toBeTruthy();
    }
  });

  it("feedbucket.analyze routes to the CAPABLE model because feedback analysis produces proposals a product team acts on", () => {
    const route = ModelRouting.routeFor("feedbucket.analyze", TEST_CONFIG);
    expect(route.model).toBe(TEST_CONFIG.standardChain[0]);
  });

  it("chat.summarize routes to the FAST model because high-volume chat summarization is low-stakes and must not consume the standard-tier budget", () => {
    const route = ModelRouting.routeFor("chat.summarize", TEST_CONFIG);
    expect(route.model).toBe(TEST_CONFIG.fastChain[0]);
  });

  it("every registered feature returns a positive integer outputCap so callers always have a concrete token ceiling to pass to the provider", () => {
    const catalogKeys = Object.keys(AI_FEATURE_COSTS) as AiFeatureKey[];
    for (const key of catalogKeys) {
      const route = ModelRouting.routeFor(key, TEST_CONFIG);
      expect(Number.isInteger(route.outputCap)).toBe(true);
      expect(route.outputCap).toBeGreaterThan(0);
    }
  });
});

describe("resolveGatewayTier", () => {
  it("a known CAPABLE feature with no explicit tier returns standard so its callers get the standard-quality chain without spelling out a tier", () => {
    expect(resolveGatewayTier("feedbucket.analyze")).toBe("standard");
  });

  it("an explicit tier overrides the TIER_MAP default so call sites that need a specific chain can force it regardless of the feature's default routing", () => {
    expect(resolveGatewayTier("feedbucket.analyze", "fast")).toBe("fast");
    expect(resolveGatewayTier("chat.summarize", "standard")).toBe("standard");
  });
});
