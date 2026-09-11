import { z } from "zod";
import {
  LeadScoreSchema,
  DealPredictionSchema,
  ChurnRiskSchema,
  NextActionSchema,
  LeadEnrichmentSchema,
  GeneratedEmailSchema,
  ObjectionResponseSchema,
  SentimentSchema,
  ConversationSummarySchema,
  PriorityResponseSchema,
  StalePipelineDigestSchema,
  DataQualityCopilotSchema,
  DealInsightsSchema,
} from "./output.schemas";

export const scoreLeadSingleResponseSchema = LeadScoreSchema.nullable();
export const scoreLeadBatchResponseSchema = z.object({
  results: z.record(z.string(), LeadScoreSchema),
  scored: z.number().int(),
});
export const scoreLeadResponseSchema = z.union([scoreLeadSingleResponseSchema, scoreLeadBatchResponseSchema]);
export const predictDealResponseSchema = DealPredictionSchema.nullable();
export const churnRiskResponseSchema = ChurnRiskSchema.nullable();
export const nextActionResponseSchema = NextActionSchema.nullable();
export const accountSummaryResponseSchema = z.object({
  summary: z.string(),
  clientName: z.string(),
  generatedAt: z.string(),
});

const nlSearchLeadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  company: z.string().nullable(),
  status: z.string(),
  priority: z.string().nullable(),
  source: z.string().nullable(),
  value: z.number().nullable(),
  city: z.string().nullable(),
  assignedTo: z.string().nullable(),
});

export const nlSearchResponseSchema = z.object({
  query: z.string(),
  parsedFilters: z.object({
    status: z.array(z.string()).optional(),
    priority: z.array(z.string()).optional(),
    source: z.string().optional(),
    city: z.string().optional(),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    company: z.string().optional(),
    nameSearch: z.string().optional(),
    assignedToName: z.string().optional(),
  }),
  leads: z.array(nlSearchLeadSchema),
  total: z.number().int(),
});

export const enrichLeadResponseSchema = LeadEnrichmentSchema;
export const generateEmailSingleResponseSchema = GeneratedEmailSchema;
export const generateEmailBatchResponseSchema = z.object({ variations: z.array(GeneratedEmailSchema) });
export const generateEmailResponseSchema = z.union([generateEmailSingleResponseSchema, generateEmailBatchResponseSchema]);
export const objectionHandlerResponseSchema = ObjectionResponseSchema;
export const sentimentAnalysisResponseSchema = SentimentSchema;
export const summarizeResponseSchema = ConversationSummarySchema;
export const reportNarratorResponseSchema = z.object({
  narrative: z.string(),
  generatedAt: z.string(),
});
export const prioritizeTasksResponseSchema = PriorityResponseSchema;

const taskSuggestionSchema = z.object({
  ticketId: z.number().int(),
  title: z.string(),
  reason: z.string(),
  priority: z.string(),
});

const workloadAnalysisSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  activeTickets: z.number().int(),
  totalPoints: z.number(),
  hoursThisWeek: z.number(),
  recommendation: z.enum(["AVAILABLE", "MODERATE", "HEAVY", "OVERLOADED"]),
});

export const suggestionsResponseSchema = z.union([
  z.object({ suggestions: z.array(taskSuggestionSchema) }),
  z.object({ workload: z.array(workloadAnalysisSchema) }),
]);

const citationItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  href: z.string().optional(),
  snippet: z.string().optional(),
});

export const leadSummaryResponseSchema = z.object({
  summary: z.string(),
  nextBestActions: z.array(z.string()),
  generatedAt: z.string(),
});

export const dealSummaryResponseSchema = z.object({
  stage: z.string(),
  generatedAt: z.string(),
}).merge(DealInsightsSchema);

export const nextBestActionsResponseSchema = z.object({
  actions: z.array(NextActionSchema),
});

export const emailDraftResponseSchema = z.object({
  subject: z.string(),
  body: z.string(),
  generatedAt: z.string(),
});

export const summarizeNotesResponseSchema = z.object({
  summary: z.string(),
  actionItems: z.array(z.string()),
  objections: z.array(z.string()),
  sentiment: z.enum(["positive", "neutral", "negative", "critical"]),
});

export const leadSummaryWithCitationsResponseSchema = z.object({
  summary: z.string(),
  nextBestActions: z.array(z.string()),
  generatedAt: z.string(),
  citations: z.array(citationItemSchema),
});

export const dealSummaryWithCitationsResponseSchema = dealSummaryResponseSchema.extend({
  citations: z.array(citationItemSchema),
});

export const duplicateSuggestionsResponseSchema = z.object({
  leadId: z.number().int(),
  duplicates: z.array(z.object({
    groupId: z.string(),
    leads: z.array(z.object({ id: z.number().int(), name: z.string(), email: z.string(), company: z.string().nullable() })),
  })),
  aiExplanation: z.string().nullable(),
  generatedAt: z.string(),
});

export const meetingFollowUpResponseSchema = z.object({
  followUp: z.string(),
  eventTitle: z.string(),
});

export const stalePipelineResponseSchema = StalePipelineDigestSchema;
export const dataQualityResponseSchema = DataQualityCopilotSchema;

export const accountSummaryWithCitationsResponseSchema = accountSummaryResponseSchema.extend({
  citations: z.array(citationItemSchema),
});
