import { ServiceUnavailableException } from "@nestjs/common";
import { AI_FEATURE_COSTS } from "../billing/ai-cost-catalog";
import {
  resolveLlmProvider,
  type LlmProviderConfig,
  type LlmProviderName,
} from "../providers/llm-provider.config";

export type ModelTier = "FAST" | "CAPABLE";

export interface ModelRoute {
  provider: LlmProviderName;
  model: string;
  outputCap: number;
}

const FAST_OUTPUT_CAP = 1_024;
const CAPABLE_OUTPUT_CAP = 2_048;

const TIER_MAP = {
  "crm.score-lead":                    "FAST",
  "crm.autonomy-extract":              "FAST",
  "crm.autonomy-shadow-score":         "FAST",
  "crm.predict-deal":                  "CAPABLE",
  "crm.churn-risk":                    "CAPABLE",
  "crm.next-action":                   "FAST",
  "crm.account-summary":               "CAPABLE",
  "crm.meeting-prep":                  "CAPABLE",
  "crm.nl-search":                     "FAST",
  "crm.enrich-lead":                   "CAPABLE",
  "crm.generate-email":                "FAST",
  "crm.objection-handler":             "FAST",
  "crm.sentiment":                     "FAST",
  "crm.summarize":                     "FAST",
  "crm.report-narrator":               "CAPABLE",
  "crm.prioritize-tasks":              "FAST",
  "crm.copilot.summary":               "FAST",
  "crm.copilot.next-best-actions":     "CAPABLE",
  "crm.copilot.email-draft":           "FAST",
  "crm.copilot.notes":                 "FAST",
  "crm.copilot.objection":             "FAST",
  "crm.copilot.duplicates":            "FAST",
  "hr.attrition-risk":                 "CAPABLE",
  "hr.generate-review":                "CAPABLE",
  "hr.generate-jd":                    "CAPABLE",
  "hr.score-candidate":                "CAPABLE",
  "hr.composite-score":                "CAPABLE",
  "hr.resume-parse":                   "FAST",
  "hr.email-template-generate":        "FAST",
  "hr.helpdesk-reply":                 "FAST",
  "pm.summary":                        "FAST",
  "pm.risks":                          "CAPABLE",
  "pm.client-update":                  "CAPABLE",
  "pm.plan":                           "CAPABLE",
  "pm.extract-tasks":                  "FAST",
  "pm.ask":                            "FAST",
  "ticket.summarize":                  "FAST",
  "ticket.summarize-comments":         "FAST",
  "ticket.improve-description":        "CAPABLE",
  "ticket.suggest-subtasks":           "FAST",
  "ticket.generate-checklist":         "FAST",
  "ticket.suggest-title":              "FAST",
  "ticket.generate-comment-draft":     "FAST",
  "ticket.suggest-fields":             "FAST",
  "support.analysis":                  "CAPABLE",
  "support.reply":                     "FAST",
  "support.macro":                     "FAST",
  "support.translate":                 "FAST",
  "support.handoff":                   "FAST",
  "support.root-cause":                "CAPABLE",
  "kb.ask":                            "CAPABLE",
  "kb.public-ask":                     "CAPABLE",
  "kb.public-embedding":               "FAST",
  "kb.search":                         "FAST",
  "kb.indexing":                       "FAST",
  "support.embedding":                 "FAST",
  "support.kb-search":                 "FAST",
  "chat.message":                      "FAST",
  "feedbucket.analyze":                "CAPABLE",
  "feedbucket.assist":                 "CAPABLE",
  "inv.insight-explain":               "CAPABLE",
  "inv.reorder-explain":               "CAPABLE",
  "inv.supplier-delay-briefing":       "CAPABLE",
  "inv.ops-brief":                     "CAPABLE",
  "inv.copilot-plan":                  "CAPABLE",
  "inv.copilot-answer":                "CAPABLE",
  "inv.demand-risk":                   "CAPABLE",
  "inv.report-builder":                "FAST",
  "accounting.variance-explain":       "CAPABLE",
  "accounting.reconciliation-explain": "CAPABLE",
  "accounting.extract-document":       "FAST",
  "meetings.prep":                     "CAPABLE",
  "meetings.follow-up":                "CAPABLE",
  "exec.brief.generate":               "CAPABLE",
  "pm.weekly-update":                  "FAST",
  "pm.change-impact":                  "CAPABLE",
  "pm.extract-meeting-actions":        "FAST",
  "ticket.handoff":                    "FAST",
  "crm.meeting-follow-up":             "CAPABLE",
  "crm.stale-pipeline":                "FAST",
  "crm.data-quality":                  "FAST",
  "hr.policy-qa":                      "CAPABLE",
  "hr.interview-kit":                  "CAPABLE",
  "hr.letter-draft":                   "CAPABLE",
  "hr.interview-notes-summary":        "CAPABLE",
  "workspace.ask":                     "CAPABLE",
  "kb.research-brief":                 "CAPABLE",
  "support.kb-gap-draft":              "CAPABLE",
  "inv.digest-narrate":                "FAST",
  "timesheets.period-summary":         "FAST",
  "timesheets.describe-entry":         "FAST",
  "timesheets.billing-narrative":      "FAST",
  "timesheets.reports-narrative":      "FAST",
  "timesheets.rejection-draft":        "FAST",
  "sign.summarize-document":           "CAPABLE",
  "kb.page-summarize":                 "CAPABLE",
  "kb.page-ask":                       "CAPABLE",
  "kb.page-improve":                   "CAPABLE",
  "kb.page-suggest-related":           "CAPABLE",
  "kb.article-summarize":              "CAPABLE",
  "kb.article-ask":                    "CAPABLE",
  "kb.article-improve":                "CAPABLE",
  "kb.article-suggest-related":        "CAPABLE",
  "blog.improve-writing":              "CAPABLE",
  "blog.suggest-title":                "CAPABLE",
  "blog.summarize":                    "CAPABLE",
  "survey.summarize-responses":        "CAPABLE",
  "chat.summarize":                    "FAST",
  "payroll.explain-payslip":           "CAPABLE",
  "timesheets.summarize":              "FAST",
  "mail.inbox-summary":                "FAST",
  "mail.thread-summary":               "FAST",
  "mail.draft":                        "FAST",
} as const satisfies Record<string, ModelTier>;

export type AiFeatureKey = keyof typeof TIER_MAP;

const missingTierKeys = Object.keys(AI_FEATURE_COSTS).filter((k) => !Object.hasOwn(TIER_MAP, k));
if (missingTierKeys.length > 0)
  throw new Error(`AI features missing tier assignments: ${missingTierKeys.join(", ")}`);

function tierOutputCap(tier: ModelTier): number {
  return tier === "CAPABLE" ? CAPABLE_OUTPUT_CAP : FAST_OUTPUT_CAP;
}

function routeFor(
  feature: AiFeatureKey,
  config: LlmProviderConfig = resolveLlmProvider(),
): ModelRoute {
  const tier = TIER_MAP[feature];
  const chain = tier === "CAPABLE" ? config.standardChain : config.fastChain;
  const model = chain[0];
  if (!model) throw new ServiceUnavailableException("AI model tier is not configured");
  return { provider: config.provider, model, outputCap: tierOutputCap(tier) };
}

function isAiFeatureKey(key: string): key is AiFeatureKey {
  return Object.hasOwn(TIER_MAP, key);
}

export function resolveGatewayTier(
  feature: string,
  explicitTier?: "fast" | "standard",
): "fast" | "standard" {
  if (explicitTier !== undefined) return explicitTier;
  if (!isAiFeatureKey(feature)) return "fast";
  return TIER_MAP[feature] === "CAPABLE" ? "standard" : "fast";
}

export const ModelRouting = { routeFor } as const;
