import { ModuleRecommendationService } from "./module-recommendation.service";

describe("ModuleRecommendationService", () => {
  const service = new ModuleRecommendationService();

  it("recommends CRM for a sales goal with an explanation", () => {
    const result = service.recommend({ goals: ["sales"] });
    expect(result.recommendedModules.map((m) => m.moduleKey)).toContain("CRM");
    expect(result.recommendedModules.find((m) => m.moduleKey === "CRM")?.reason).toMatch(/Grow Sales/);
  });

  it("de-duplicates modules recommended by multiple goals", () => {
    const result = service.recommend({ goals: ["sales", "everything"] });
    const crmCount = result.recommendedModules.filter((m) => m.moduleKey === "CRM").length;
    expect(crmCount).toBe(1);
  });

  it("falls back to default modules when no goals are selected", () => {
    const result = service.recommend({ goals: [] });
    expect(result.recommendedModules.length).toBeGreaterThan(0);
  });

  it("adds an industry-specific module even if not implied by goals", () => {
    const result = service.recommend({ goals: ["hr"], industry: "Retail" });
    expect(result.recommendedModules.map((m) => m.moduleKey)).toContain("INVENTORY");
  });

  it("recommends the PAYMENTS checklist template for commerce-ish goals", () => {
    const result = service.recommend({ goals: ["finance"] });
    expect(result.requiredSetupChecklistTemplates).toContain("PAYMENTS");
  });

  it("does not recommend the PAYMENTS checklist template for non-commerce goals", () => {
    const result = service.recommend({ goals: ["projects"] });
    expect(result.requiredSetupChecklistTemplates).not.toContain("PAYMENTS");
  });

  describe("shouldRecommendPayments", () => {
    it("returns true for sales/finance/everything goals", () => {
      expect(service.shouldRecommendPayments(["sales"])).toBe(true);
      expect(service.shouldRecommendPayments(["finance"])).toBe(true);
      expect(service.shouldRecommendPayments(["everything"])).toBe(true);
    });

    it("returns false for goals with no commerce implication", () => {
      expect(service.shouldRecommendPayments(["projects", "support"])).toBe(false);
    });
  });
});
