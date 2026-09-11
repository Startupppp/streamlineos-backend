import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const scoreLeadSingleSchema = z.object({
  leadId: z.number().int().positive(),
});

export const scoreLeadBatchSchema = z.object({
  leadIds: z.array(z.number().int().positive()).min(1).max(50),
});

export const predictDealSchema = z.object({
  dealId: z.number().int().positive(),
}).strict();
export type PredictDealInput = z.infer<typeof predictDealSchema>;

export const churnRiskSchema = z.object({
  clientId: z.number().int().positive(),
  openTickets: z.number().optional(),
  ticketsLast90Days: z.number().optional(),
  daysSinceLastActivity: z.number().nullable().optional(),
}).strict();
export type ChurnRiskInput = z.infer<typeof churnRiskSchema>;

export const accountSummarySchema = z.object({
  clientId: z.number().int().positive(),
}).strict();
export type AccountSummaryInput = z.infer<typeof accountSummarySchema>;

export const nlSearchSchema = z.object({
  query: z.string().min(1).max(500),
}).strict();
export type NlSearchInput = z.infer<typeof nlSearchSchema>;

export const enrichLeadSchema = z.object({
  name: z.string().min(1),
  company: z.string().optional(),
  email: z.string().optional(),
  designation: z.string().optional(),
  city: z.string().optional(),
}).strict();
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
}).strict();
export type GenerateEmailInput = z.infer<typeof generateEmailSchema>;

export const nextActionSchema = z.object({
  leadId: z.number().int().positive(),
}).strict();
export type NextActionInput = z.infer<typeof nextActionSchema>;

export const objectionHandlerSchema = z.object({
  objection: z.string().min(1).max(2000),
  dealStage: z.string().min(1).max(100),
  productName: z.string().max(200).optional(),
  dealValue: z.string().max(100).optional(),
}).strict();
export type ObjectionHandlerInput = z.infer<typeof objectionHandlerSchema>;

export const reportNarratorSchema = z.object({
  data: z.string().min(1).max(10000),
  context: z.string().max(500).optional(),
}).strict();
export type ReportNarratorInput = z.infer<typeof reportNarratorSchema>;

export const sentimentAnalysisSchema = z.object({
  text: z.string().min(10).max(10000),
  clientName: z.string().max(100).optional(),
}).strict();
export type SentimentAnalysisInput = z.infer<typeof sentimentAnalysisSchema>;

export const summarizeSchema = z.object({
  activityType: z.string().min(1),
  subject: z.string().optional(),
  notes: z.string().min(1, "Notes are required for summarization"),
  leadName: z.string().optional(),
  dealName: z.string().optional(),
}).strict();
export type SummarizeInput = z.infer<typeof summarizeSchema>;

export const suggestionsQuerySchema = z.object({
  type: z.string().optional(),
  projectId: z.string().optional(),
}).strict();
export type SuggestionsQueryInput = z.infer<typeof suggestionsQuerySchema>;

export const attritionRiskSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
}).strict();
export type AttritionRiskInput = z.infer<typeof attritionRiskSchema>;

export const generateReviewSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  periodStart: z.string().min(1, "Period start required"),
  periodEnd: z.string().min(1, "Period end required"),
}).strict();
export type GenerateReviewInput = z.infer<typeof generateReviewSchema>;

export const generateJdSchema = z.object({
  title: z.string().min(1).max(200),
  requirements: z.string().optional(),
  location: z.string().optional(),
  type: z.string().optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
}).strict();
export type GenerateJdInput = z.infer<typeof generateJdSchema>;

export const scoreCandidateSchema = z.object({
  candidateId: z.number().int().positive(),
  jobId: z.number().int().positive().optional(),
}).strict();
export type ScoreCandidateInput = z.infer<typeof scoreCandidateSchema>;

export const helpdeskReplySchema = z.object({
  ticketId: z.number().int().positive(),
}).strict();
export type HelpdeskReplyInput = z.infer<typeof helpdeskReplySchema>;

export const kbAskSchema = z.object({
  org: z.string().trim().min(1),
  question: z.string().trim().min(3, "Question is too short").max(1000),
}).strict();
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
  persona: z.string().optional(),
}).strict();

export const chatHistoryQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(30, 100),
});

export const conversationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
}).strict();

export const conversationRenameSchema = z.object({
  title: z.string().trim().min(1).max(200),
}).strict();

export const conversationsListQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(20, 50),
});

export const conversationMessagesQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: pageSizeField(30, 100),
});

export const policyQaSchema = z.object({
  question: z.string().trim().min(3).max(1000),
}).strict();
export type PolicyQaInput = z.infer<typeof policyQaSchema>;

export const interviewKitSchema = z.object({
  jobPostingId: z.number().int().positive(),
}).strict();
export type InterviewKitInput = z.infer<typeof interviewKitSchema>;

export const letterDraftSchema = z.object({
  userId: z.string().min(1),
  letterType: z.enum(["offer", "appointment", "appreciation", "warning", "promotion", "termination_notice", "experience"]),
  details: z.string().max(2000).optional(),
}).strict();
export type LetterDraftInput = z.infer<typeof letterDraftSchema>;

export const interviewNotesSummarySchema = z.object({
  candidateId: z.number().int().positive(),
  jobPostingId: z.number().int().positive().optional(),
}).strict();
export type InterviewNotesSummaryInput = z.infer<typeof interviewNotesSummarySchema>;

export const acceptCandidateScoreSchema = z.object({
  candidateId: z.number().int().positive(),
  aiScore: z.number().int().min(0).max(100),
}).strict();
export type AcceptCandidateScoreInput = z.infer<typeof acceptCandidateScoreSchema>;

export const nextBestActionsSchema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
  withEvidence: z.boolean().optional().default(true),
});
export type NextBestActionsInput = z.infer<typeof nextBestActionsSchema>;

export const emailDraftSchema = z.object({
  entityType: z.enum(["lead", "deal"]),
  entityId: z.number().int().positive(),
  intent: z.string().min(1).max(1000),
  tone: z.enum(["formal", "friendly", "urgent"]).default("friendly"),
});
export type EmailDraftInput = z.infer<typeof emailDraftSchema>;

export const summarizeNotesSchema = z.object({
  text: z.string().min(10).max(8000),
});
export type SummarizeNotesInput = z.infer<typeof summarizeNotesSchema>;

export const objectionHelpSchema = z.object({
  objection: z.string().min(1).max(2000),
  context: z.string().max(1000).optional(),
});
export type ObjectionHelpInput = z.infer<typeof objectionHelpSchema>;

export const meetingFollowUpSchema = z.object({
  meetingTitle: z.string().min(1).max(200),
  attendeeType: z.enum(["lead", "client"]),
  attendeeId: z.number().int().positive(),
  outcome: z.string().min(1).max(3000),
  actionItems: z.array(z.string().max(500)).max(20).optional(),
  scheduledAt: z.string(),
  notes: z.string().max(2000).optional(),
});
export type MeetingFollowUpBodyInput = z.infer<typeof meetingFollowUpSchema>;

export const accountSummaryWithCitationsSchema = z.object({
  clientId: z.number().int().positive(),
});
export type AccountSummaryWithCitationsInput = z.infer<typeof accountSummaryWithCitationsSchema>;

export const stalePipelineQuerySchema = z.object({
  inactiveDays: z.coerce.number().int().min(1).max(90).default(14),
});
export type StalePipelineQuery = z.infer<typeof stalePipelineQuerySchema>;

export const confirmActionBodySchema = z.object({ token: z.string().min(1) });
export type ConfirmActionBodyInput = z.infer<typeof confirmActionBodySchema>;

export const mailSendPayloadSchema = z.object({
  accountId: z.number().int().positive(),
  toEmail: z.string().email(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1),
});

export const blogImproveWritingSchema = z.object({ content: z.string().min(1).max(10000) });
export type BlogImproveWritingInput = z.infer<typeof blogImproveWritingSchema>;

export const blogSuggestTitleSchema = z.object({
  content: z.string().max(10000).optional(),
});
export type BlogSuggestTitleInput = z.infer<typeof blogSuggestTitleSchema>;

export const blogSummarizeSchema = z.object({ content: z.string().max(10000).optional() });
export type BlogSummarizeInput = z.infer<typeof blogSummarizeSchema>;

// Redeemed on a later request than the one that proposed it: parse, never coerce, and stay non-strict for the card's title and reason.
export const ticketStatusUpdatePayloadSchema = z.object({
  ticketId: z.coerce.number().int().positive(),
  status: z.string().trim().min(1),
});
export type TicketStatusUpdatePayload = z.infer<typeof ticketStatusUpdatePayloadSchema>;
