import { Injectable } from "@nestjs/common";

export interface ModuleRecommendationInput {
  goals: string[];
  industry?: string;
  companySize?: string;
  country?: string;
}

export interface RecommendedModule {
  moduleKey: string;
  reason: string;
}

export interface ModuleRecommendationResult {
  recommendedModules: RecommendedModule[];
  requiredSetupChecklistTemplates: string[];
}

// Deterministic, explainable rules — matches the frontend's goal->app mapping
// (features/org-setup/lib/constants.ts) so recommendations stay consistent between
// the org-setup wizard and this service. Rule-based rather than model-backed so every
// recommendation can state exactly why it was suggested, per the PRD's "AI
// recommendations must be explainable" requirement; a model-backed recommender can be
// swapped in later behind this same interface without changing callers.
const GOAL_RULES: Record<string, { modules: string[]; reason: string }> = {
  sales: { modules: ["CRM"], reason: "You selected \"Grow Sales\" — CRM manages your pipeline and leads." },
  hr: { modules: ["HR"], reason: "You selected \"Manage Employees\" — HR handles employee records and onboarding." },
  inventory: { modules: ["INVENTORY"], reason: "You selected \"Manage Inventory\" — Inventory tracks stock and warehouses." },
  finance: { modules: ["FINANCE"], reason: "You selected \"Finance & Accounting\" — Accounting handles invoices and taxes." },
  support: { modules: ["HELPDESK"], reason: "You selected \"Customer Support\" — Support manages tickets and SLAs." },
  projects: { modules: ["PROJECTS"], reason: "You selected \"Projects\" — Projects tracks tasks and delivery." },
  ai: { modules: ["CRM", "HR", "PROJECTS"], reason: "You selected \"AI Automation\" — these modules benefit most from AI workflows." },
  everything: {
    modules: ["CRM", "HR", "PROJECTS", "FINANCE", "INVENTORY", "HELPDESK"],
    reason: "You selected \"Build Everything\" — enabling the full suite.",
  },
};

const COMMERCE_GOALS = new Set(["sales", "finance", "everything"]);

const INDUSTRY_EXTRA_MODULES: Record<string, { modules: string[]; reason: string }> = {
  "it services": { modules: ["PROJECTS"], reason: "IT services businesses typically track delivery with Projects." },
  "retail": { modules: ["INVENTORY"], reason: "Retail businesses typically need Inventory for stock tracking." },
  "manufacturing": { modules: ["INVENTORY"], reason: "Manufacturing businesses typically need Inventory for stock and production." },
  "distribution": { modules: ["INVENTORY"], reason: "Distribution businesses typically need Inventory for stock tracking." },
};

const DEFAULT_MODULES = ["CRM", "HR", "PROJECTS"];

@Injectable()
export class ModuleRecommendationService {
  recommend(input: ModuleRecommendationInput): ModuleRecommendationResult {
    const byModule = new Map<string, string>();

    for (const goal of input.goals) {
      const rule = GOAL_RULES[goal];
      if (!rule) continue;
      for (const moduleKey of rule.modules) {
        if (!byModule.has(moduleKey)) byModule.set(moduleKey, rule.reason);
      }
    }

    if (input.industry) {
      const industryRule = INDUSTRY_EXTRA_MODULES[input.industry.trim().toLowerCase()];
      if (industryRule) {
        for (const moduleKey of industryRule.modules) {
          if (!byModule.has(moduleKey)) byModule.set(moduleKey, industryRule.reason);
        }
      }
    }

    if (byModule.size === 0) {
      for (const moduleKey of DEFAULT_MODULES) {
        byModule.set(moduleKey, "Recommended default modules to get started.");
      }
    }

    const wantsCommerce = input.goals.some((g) => COMMERCE_GOALS.has(g));
    const requiredSetupChecklistTemplates = Array.from(byModule.keys());
    if (wantsCommerce) requiredSetupChecklistTemplates.push("PAYMENTS");

    return {
      recommendedModules: Array.from(byModule.entries()).map(([moduleKey, reason]) => ({ moduleKey, reason })),
      requiredSetupChecklistTemplates,
    };
  }

  /** Whether the payments setup step/checklist should be shown, per PRD 04 "Payments Step" rules. */
  shouldRecommendPayments(goals: string[]): boolean {
    return goals.some((g) => COMMERCE_GOALS.has(g));
  }
}
