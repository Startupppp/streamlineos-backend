import { HttpException, HttpStatus } from "@nestjs/common";

export const PLANS = ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;
export type Plan = (typeof PLANS)[number];

export const FEATURES = [
  "ai.lead-scoring",
  "ai.email-drafting",
  "ai.enrichment",
  "ai.churn-risk",
  "ai.attrition-risk",
  "ai.next-action",
  "ai.deal-prediction",
  "ai.deal-summary",
  "ai.candidate-scoring",
  "ai.review-generation",
  "ai.reply-suggestion",
  "ai.project-manager",
  "hr.payroll",
  "hr.performance-reviews",
  "hr.recruitment-ats",
  "crm.advanced-reports",
  "crm.custom-fields",
  "crm.sla-tracking",
  "crm.web-forms",
  "projects.advanced",
  "integrations.google",
  "integrations.zapier",
  "branches.multi-location",
  "branding.custom",
  "rbac.custom-roles",
  "audit-log.full",
] as const;

export type Feature = (typeof FEATURES)[number];

const PLAN_FEATURES: Record<Plan, ReadonlySet<Feature>> = {
  FREE: new Set<Feature>([]),
  STARTER: new Set<Feature>([
    "hr.payroll",
    "crm.advanced-reports",
    "crm.custom-fields",
  ]),
  PROFESSIONAL: new Set<Feature>([
    "ai.lead-scoring",
    "ai.email-drafting",
    "ai.next-action",
    "ai.enrichment",
    "ai.churn-risk",
    "ai.attrition-risk",
    "ai.deal-prediction",
    "ai.deal-summary",
    "ai.candidate-scoring",
    "ai.review-generation",
    "ai.reply-suggestion",
    "ai.project-manager",
    "hr.payroll",
    "hr.performance-reviews",
    "hr.recruitment-ats",
    "crm.advanced-reports",
    "crm.custom-fields",
    "crm.sla-tracking",
    "crm.web-forms",
    "projects.advanced",
    "integrations.google",
    "audit-log.full",
  ]),
  ENTERPRISE: new Set<Feature>(FEATURES),
};

function isPlan(value: string | null | undefined): value is Plan {
  return value !== null && value !== undefined && (PLANS as readonly string[]).includes(value);
}

export function canUseFeature(plan: string | null | undefined, feature: Feature): boolean {
  if (!isPlan(plan)) return false;
  return PLAN_FEATURES[plan].has(feature);
}

export function minPlanFor(feature: Feature): Plan | null {
  for (const plan of PLANS) {
    if (PLAN_FEATURES[plan].has(feature)) return plan;
  }
  return null;
}

export function requireFeature(plan: string | null | undefined, feature: Feature): void {
  if (canUseFeature(plan, feature)) return;
  throw new HttpException(
    {
      error: `This feature requires a higher plan. Current: ${plan ?? "none"}.`,
      requiredPlan: minPlanFor(feature),
    },
    HttpStatus.PAYMENT_REQUIRED,
  );
}
