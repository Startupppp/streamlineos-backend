import { definePrompt } from "./prompt-registry";
import {
  leadScoringPrompt,
  dealPredictionPrompt,
  nextActionPrompt,
  churnRiskPrompt,
  conversationSummaryPrompt,
  leadEnrichmentPrompt,
  emailGeneratorPrompt,
  type LeadScoringInput,
  type DealPredictionInput,
  type NextActionInput,
  type ChurnRiskInput,
  type ConversationSummaryInput,
  type LeadEnrichmentInput,
  type EmailGeneratorInput,
} from "../prompts/crm.prompts";
import {
  candidateScoringPrompt,
  reviewDraftPrompt,
  helpdeskReplyPrompt,
  attritionRiskPrompt,
  type CandidateScoringInput,
  type ReviewDraftInput,
  type HelpdeskReplyInput,
  type AttritionRiskInput,
} from "../prompts/hr.prompts";
import {
  summaryPrompt,
  risksPrompt,
  clientUpdatePrompt,
  planPrompt,
  extractPrompt,
  askPrompt,
  type SummaryPromptContext,
  type RisksPromptContext,
  type ClientUpdatePromptContext,
  type PlanPromptContext,
  type ExtractPromptContext,
  type AskPromptContext,
} from "../prompts/pm.prompts";

export const crmLeadScoringPrompt = definePrompt<LeadScoringInput>({
  key: "crm.lead_scoring",
  version: 1,
  build: leadScoringPrompt,
});

export const crmDealPredictionPrompt = definePrompt<DealPredictionInput>({
  key: "crm.deal_prediction",
  version: 1,
  build: dealPredictionPrompt,
});

export const crmNextActionPrompt = definePrompt<NextActionInput>({
  key: "crm.next_action",
  version: 1,
  build: nextActionPrompt,
});

export const crmChurnRiskPrompt = definePrompt<ChurnRiskInput>({
  key: "crm.churn_risk",
  version: 1,
  build: churnRiskPrompt,
});

export const crmConversationSummaryPrompt = definePrompt<ConversationSummaryInput>({
  key: "crm.conversation_summary",
  version: 1,
  build: conversationSummaryPrompt,
});

export const crmLeadEnrichmentPrompt = definePrompt<LeadEnrichmentInput>({
  key: "crm.lead_enrichment",
  version: 1,
  build: leadEnrichmentPrompt,
});

export const crmEmailGeneratorPrompt = definePrompt<EmailGeneratorInput>({
  key: "crm.email_generator",
  version: 1,
  build: emailGeneratorPrompt,
});

export const hrCandidateScoringPrompt = definePrompt<CandidateScoringInput>({
  key: "hr.candidate_scoring",
  version: 1,
  build: candidateScoringPrompt,
});

export const hrReviewDraftPrompt = definePrompt<ReviewDraftInput>({
  key: "hr.review_draft",
  version: 1,
  build: reviewDraftPrompt,
});

export const hrHelpdeskReplyPrompt = definePrompt<HelpdeskReplyInput>({
  key: "hr.helpdesk_reply",
  version: 1,
  build: helpdeskReplyPrompt,
});

export const hrAttritionRiskPrompt = definePrompt<AttritionRiskInput>({
  key: "hr.attrition_risk",
  version: 1,
  build: attritionRiskPrompt,
});

export const pmSummaryPrompt = definePrompt<SummaryPromptContext>({
  key: "pm.summary",
  version: 1,
  build: summaryPrompt,
});

export const pmRisksPrompt = definePrompt<RisksPromptContext>({
  key: "pm.risks",
  version: 1,
  build: risksPrompt,
});

export const pmClientUpdatePrompt = definePrompt<ClientUpdatePromptContext>({
  key: "pm.client_update",
  version: 1,
  build: clientUpdatePrompt,
});

export const pmPlanPrompt = definePrompt<PlanPromptContext>({
  key: "pm.plan",
  version: 1,
  build: planPrompt,
});

export const pmExtractPrompt = definePrompt<ExtractPromptContext>({
  key: "pm.extract",
  version: 1,
  build: extractPrompt,
});

export const pmAskPrompt = definePrompt<AskPromptContext>({
  key: "pm.ask",
  version: 1,
  build: askPrompt,
});
