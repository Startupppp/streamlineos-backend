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
  winProbability: z.number().min(0).max(100).describe("Win probability 0-100"),
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
