import { z } from "zod";

export const LeadScoreSchema = z.object({
  score: z.number().min(0).max(100).describe("Score from 0 (cold) to 100 (hot)"),
  confidence: z.enum(["low", "medium", "high"]).default("medium").describe("Confidence level of this score"),
  reasoning: z.string().describe("1-2 sentence explanation of the score"),
  strengths: z.array(z.string()).describe("Top 1-3 strengths of this lead"),
  weaknesses: z.array(z.string()).describe("Top 1-2 weaknesses or risks"),
  suggestedActions: z.array(z.string()).describe("2-3 concrete next actions to take"),
});
export type LeadScoreResult = z.infer<typeof LeadScoreSchema>;

export const EmailToneSchema = z.enum(["formal", "friendly", "urgent"]);
export type EmailTone = z.infer<typeof EmailToneSchema>;

export const GeneratedEmailSchema = z.object({
  subject: z.string().describe("Email subject line, max 60 characters"),
  body: z.string().describe("Email body text, max 150 words"),
});
export type GeneratedEmail = z.infer<typeof GeneratedEmailSchema>;

export const DealPredictionSchema = z.object({
  winProbability: z.number().min(0).max(100).describe("AI win-probability estimate 0-100; not a validated statistical probability"),
  estimateDisclaimer: z.string().default("This is an AI estimate based on available signals, not a statistically validated probability."),
  confidence: z.enum(["low", "medium", "high"]),
  reasoning: z.string(),
  riskFactors: z.array(z.string()),
  positiveSignals: z.array(z.string()),
  recommendedActions: z.array(z.string()),
});
export type DealPredictionResult = z.infer<typeof DealPredictionSchema>;

export const NextActionSchema = z.object({
  action: z.string().describe("Concise action description, max 10 words"),
  urgency: z.enum(["low", "medium", "high", "critical"]),
  reasoning: z.string().describe("1 sentence why this action"),
  template: z.string().describe("Optional message template if action is email/call. Empty string if not applicable."),
});
export type NextActionResult = z.infer<typeof NextActionSchema>;

export const ChurnRiskSchema = z.object({
  churnRiskScore: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]).default("medium").describe("Confidence level of this churn risk score"),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  reasoning: z.string(),
  riskFactors: z.array(z.string()),
  retentionActions: z.array(z.string()),
});
export type ChurnRiskResult = z.infer<typeof ChurnRiskSchema>;

export const ConversationSummarySchema = z.object({
  summary: z.string().describe("1-2 sentence summary"),
  keyPoints: z.array(z.string()),
  actionItems: z.array(z.string()),
  sentiment: z.enum(["positive", "neutral", "negative"]),
});
export type ConversationSummaryResult = z.infer<typeof ConversationSummarySchema>;

export const LeadEnrichmentSchema = z.object({
  companyInsight: z.string(),
  estimatedCompanySize: z.string(),
  industry: z.string(),
  talkingPoints: z.array(z.string()),
  potentialNeeds: z.array(z.string()),
  recommendedApproach: z.string(),
});
export type LeadEnrichmentResult = z.infer<typeof LeadEnrichmentSchema>;

export const CandidateScoreSchema = z.object({
  score: z.number().min(0).max(100),
  fitLevel: z.enum(["excellent", "good", "average", "poor"]),
  reasoning: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  suggestedQuestions: z.array(z.string()).describe("3-5 interview questions to validate the candidate"),
});
export type CandidateScoreResult = z.infer<typeof CandidateScoreSchema>;

export const ReviewRatingItemSchema = z.object({
  category: z.string(),
  score: z.number().min(1).max(5),
  comment: z.string(),
});

export const ReviewDraftSchema = z.object({
  overallRating: z.number().min(1).max(5),
  strengths: z.string().describe("2-3 sentences highlighting strengths"),
  improvements: z.string().describe("2-3 sentences on areas for growth"),
  comments: z.string().describe("1-2 sentences overall summary"),
  ratings: z.array(ReviewRatingItemSchema).describe("Ratings per category (5 categories)"),
});
export type ReviewDraftResult = z.infer<typeof ReviewDraftSchema>;

export const HelpdeskReplySchema = z.object({
  suggestedReply: z.string().describe("Professional reply text, max 100 words"),
  category: z.string().describe("Inferred category: Leave / Payroll / IT / Benefits / Policy / Other"),
  estimatedResolutionTime: z.string().describe("e.g. 24 hours, 2-3 business days"),
  followUpActions: z.array(z.string()),
});
export type HelpdeskReplyResult = z.infer<typeof HelpdeskReplySchema>;

export const AttritionRiskSchema = z.object({
  attritionRiskScore: z.number().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  reasoning: z.string(),
  riskFactors: z.array(z.string()),
  retentionActions: z.array(z.string()),
});
export type AttritionRiskResult = z.infer<typeof AttritionRiskSchema>;

export const NlSearchFilterSchema = z.object({
  status: z.array(z.string()).optional(),
  priority: z.array(z.string()).optional(),
  source: z.string().optional(),
  city: z.string().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  company: z.string().optional(),
  nameSearch: z.string().optional(),
  assignedToName: z.string().optional(),
});
export type NlSearchFilters = z.infer<typeof NlSearchFilterSchema>;

export const ObjectionResponseSchema = z.object({
  counterArguments: z.array(z.string()),
  talkingPoints: z.array(z.string()),
  suggestedResponse: z.string(),
});

export const SentimentSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative", "critical"]),
  score: z.number().min(0).max(100),
  summary: z.string(),
  riskFactors: z.array(z.string()),
  recommendations: z.array(z.string()),
  churnRisk: z.enum(["low", "medium", "high"]),
});

export const PriorityItemSchema = z.object({
  taskId: z.number(),
  rank: z.number(),
  urgencyScore: z.number().min(0).max(100),
  reasoning: z.string(),
});

export const PriorityResponseSchema = z.object({
  items: z.array(PriorityItemSchema),
  summary: z.string(),
});

export const PolicyQaSchema = z.object({
  answer: z.string(),
  confidence: z.enum(["high", "medium", "low", "not_found"]),
  citations: z.array(z.object({
    policyType: z.string(),
    policyId: z.number(),
    snippet: z.string(),
  })),
  shouldEscalate: z.boolean(),
  escalationReason: z.string().optional(),
});
export type PolicyQaResult = z.infer<typeof PolicyQaSchema>;

export const InterviewKitRoundSchema = z.object({
  round: z.string(),
  questions: z.array(z.object({
    question: z.string(),
    category: z.string(),
    expectedAnswer: z.string(),
    redFlags: z.array(z.string()),
  })),
  rubric: z.array(z.object({
    criterion: z.string(),
    weight: z.number(),
    description: z.string(),
  })),
});

export const InterviewKitSchema = z.object({
  roundKits: z.array(InterviewKitRoundSchema),
});
export type InterviewKitResult = z.infer<typeof InterviewKitSchema>;

export const LetterDraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  disclaimer: z.string(),
});
export type LetterDraftResult = z.infer<typeof LetterDraftSchema>;

export const InterviewNotesSummarySchema = z.object({
  overallRecommendation: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
  strengthsSummary: z.string(),
  concernsSummary: z.string(),
  roundSummaries: z.array(z.object({
    round: z.string(),
    verdict: z.string(),
    keyPoints: z.array(z.string()),
  })),
  suggestedNextStep: z.string(),
});
export type InterviewNotesSummaryResult = z.infer<typeof InterviewNotesSummarySchema>;

export const EvidenceItemSchema = z.object({
  kind: z.enum(["activity", "stage", "signal", "field"]),
  label: z.string(),
  value: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const NextActionWithEvidenceSchema = z.object({
  action: z.string().describe("Concise action, max 10 words"),
  urgency: z.enum(["low", "medium", "high", "critical"]),
  reasoning: z.string().describe("1 sentence why"),
  template: z.string().describe("Message template if email/call, else empty string"),
  evidence: z.array(EvidenceItemSchema).describe("2-4 signals used to reach this recommendation"),
  rationale: z.string().describe("1-2 sentences explaining what evidence drove the recommendation"),
});
export type NextActionWithEvidenceResult = z.infer<typeof NextActionWithEvidenceSchema>;

export const StaleDealSchema = z.object({
  dealId: z.number(),
  dealName: z.string(),
  stage: z.string(),
  value: z.number(),
  daysSinceActivity: z.number(),
  assignedToId: z.string().nullable(),
  evidence: z.array(z.string()).describe("2-3 deterministic signals about why this deal is stale"),
});
export type StaleDeal = z.infer<typeof StaleDealSchema>;

export const StalePipelineDigestSchema = z.object({
  summary: z.string().describe("2-3 sentence overview of pipeline health"),
  criticalCount: z.number(),
  groupedByStage: z.record(z.string(), z.array(z.string())).describe("stage => deal names with evidence"),
  topRisk: z.string().describe("1 sentence on the biggest stale risk"),
});
export type StalePipelineDigest = z.infer<typeof StalePipelineDigestSchema>;

export const DataQualityIssueSchema = z.object({
  entityType: z.enum(["lead", "deal"]),
  entityId: z.number(),
  entityName: z.string(),
  issueKind: z.enum(["missing_field", "likely_duplicate", "incomplete_stage", "stale_data"]),
  field: z.string().nullable().describe("Which field is missing or problematic"),
  severity: z.enum(["low", "medium", "high"]),
  suggestedFix: z.string().describe("What the user should do to fix this issue"),
});
export type DataQualityIssue = z.infer<typeof DataQualityIssueSchema>;

export const DataQualityCopilotSchema = z.object({
  issues: z.array(DataQualityIssueSchema),
  summary: z.string().describe("1-2 sentence overall data health summary"),
  priorityAction: z.string().describe("The single most important fix right now"),
  totalIssues: z.number(),
});
export type DataQualityCopilotResult = z.infer<typeof DataQualityCopilotSchema>;
