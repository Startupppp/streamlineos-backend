import { z } from "zod";

export const scoreLeadSingleSchema = z.object({
  leadId: z.number().int().positive(),
});
export type ScoreLeadSingleInput = z.infer<typeof scoreLeadSingleSchema>;

export const scoreLeadBatchSchema = z.object({
  leadIds: z.array(z.number().int().positive()).min(1).max(50),
});
export type ScoreLeadBatchInput = z.infer<typeof scoreLeadBatchSchema>;

export const predictDealSchema = z.object({
  dealId: z.number().int().positive(),
});
export type PredictDealInput = z.infer<typeof predictDealSchema>;

export const churnRiskSchema = z.object({
  clientId: z.number().int().positive(),
  openTickets: z.number().optional(),
  ticketsLast90Days: z.number().optional(),
  daysSinceLastActivity: z.number().nullable().optional(),
});
export type ChurnRiskInput = z.infer<typeof churnRiskSchema>;

export const accountSummarySchema = z.object({
  clientId: z.number().int().positive(),
});
export type AccountSummaryInput = z.infer<typeof accountSummarySchema>;

export const nlSearchSchema = z.object({
  query: z.string().min(1).max(500),
});
export type NlSearchInput = z.infer<typeof nlSearchSchema>;

export const enrichLeadSchema = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  email: z.string().optional(),
  designation: z.string().optional(),
  city: z.string().optional(),
});
export type EnrichLeadInput = z.infer<typeof enrichLeadSchema>;

export const generateEmailSchema = z.object({
  leadName: z.string().min(1),
  company: z.string().optional(),
  designation: z.string().optional(),
  dealStage: z.string().optional(),
  lastActivityType: z.string().optional(),
  lastActivityDate: z.string().optional(),
  lastActivityNotes: z.string().optional(),
  potentialValue: z.string().optional(),
  tone: z.enum(["formal", "friendly", "urgent"]).default("friendly"),
  context: z.string().optional(),
  allVariations: z.boolean().optional(),
});
export type GenerateEmailInput = z.infer<typeof generateEmailSchema>;

export const nextActionSchema = z.object({
  leadId: z.number().int().positive(),
});
export type NextActionInput = z.infer<typeof nextActionSchema>;

export const meetingPrepSchema = z.object({
  meetingTitle: z.string().min(1).max(200),
  attendeeType: z.enum(["lead", "client"]),
  attendeeId: z.number().int().positive(),
  scheduledAt: z.string(),
  notes: z.string().max(2000).optional(),
});
export type MeetingPrepInput = z.infer<typeof meetingPrepSchema>;

export const objectionHandlerSchema = z.object({
  objection: z.string().min(1).max(2000),
  dealStage: z.string().min(1).max(100),
  productName: z.string().max(200).optional(),
  dealValue: z.string().max(100).optional(),
});
export type ObjectionHandlerInput = z.infer<typeof objectionHandlerSchema>;

export const reportNarratorSchema = z.object({
  data: z.string().min(1).max(10000),
  context: z.string().max(500).optional(),
});
export type ReportNarratorInput = z.infer<typeof reportNarratorSchema>;

export const sentimentAnalysisSchema = z.object({
  text: z.string().min(10).max(10000),
  clientName: z.string().max(100).optional(),
});
export type SentimentAnalysisInput = z.infer<typeof sentimentAnalysisSchema>;

export const summarizeSchema = z.object({
  activityType: z.string().min(1),
  subject: z.string().optional(),
  notes: z.string().min(1, "Notes are required for summarization"),
  leadName: z.string().optional(),
  dealName: z.string().optional(),
});
export type SummarizeInput = z.infer<typeof summarizeSchema>;

export const suggestionsQuerySchema = z.object({
  type: z.string().optional(),
  projectId: z.string().optional(),
});
export type SuggestionsQueryInput = z.infer<typeof suggestionsQuerySchema>;

export const attritionRiskSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
});
export type AttritionRiskInput = z.infer<typeof attritionRiskSchema>;

export const generateReviewSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  periodStart: z.string().min(1, "Period start required"),
  periodEnd: z.string().min(1, "Period end required"),
});
export type GenerateReviewInput = z.infer<typeof generateReviewSchema>;

export const generateJdSchema = z.object({
  title: z.string().min(1).max(200),
  requirements: z.string().optional(),
  location: z.string().optional(),
  type: z.string().optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
});
export type GenerateJdInput = z.infer<typeof generateJdSchema>;

export const scoreCandidateSchema = z.object({
  candidateId: z.number().int().positive(),
  jobId: z.number().int().positive().optional(),
});
export type ScoreCandidateInput = z.infer<typeof scoreCandidateSchema>;

export const helpdeskReplySchema = z.object({
  ticketId: z.number().int().positive(),
});
export type HelpdeskReplyInput = z.infer<typeof helpdeskReplySchema>;

export const kbAskSchema = z.object({
  org: z.string().trim().min(1),
  question: z.string().trim().min(3, "Question is too short").max(1000),
});
export type KbAskInput = z.infer<typeof kbAskSchema>;

export const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(10000),
      }),
    )
    .min(1)
    .max(50),
  conversationId: z.number().int().positive().optional(),
});
export type ChatRequestInput = z.infer<typeof chatRequestSchema>;

export const chatHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ChatHistoryQueryInput = z.infer<typeof chatHistoryQuerySchema>;

export const conversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
export type ConversationCreateInput = z.infer<typeof conversationCreateSchema>;

export const conversationRenameSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type ConversationRenameInput = z.infer<typeof conversationRenameSchema>;

export const conversationsListQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ConversationsListQueryInput = z.infer<typeof conversationsListQuerySchema>;

export const conversationMessagesQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ConversationMessagesQueryInput = z.infer<typeof conversationMessagesQuerySchema>;
