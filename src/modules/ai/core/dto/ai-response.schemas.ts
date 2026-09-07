import { z } from "zod";
import { successSchema } from "../../../../common/openapi/response-envelopes";
import {
  LeadScoreSchema,
  DealPredictionSchema,
  ChurnRiskSchema,
  NextActionSchema,
  NextActionWithEvidenceSchema,
  LeadEnrichmentSchema,
  GeneratedEmailSchema,
  ObjectionResponseSchema,
  SentimentSchema,
  ConversationSummarySchema,
  PriorityResponseSchema,
  StalePipelineDigestSchema,
  DataQualityCopilotSchema,
  DealInsightsSchema,
  AttritionRiskSchema,
  ReviewDraftSchema,
  CandidateScoreSchema,
  HelpdeskReplySchema,
  PolicyQaSchema,
  InterviewKitSchema,
  LetterDraftSchema,
  InterviewNotesSummarySchema,
} from "./output.schemas";
import { agendaOutputSchema, followUpOutputSchema } from "./meetings-output.schemas";

const advisoryFields = {
  advisory: z.literal(true),
  disclaimer: z.string(),
};

// ─── AI Feedback ───────────────────────────────────────────────────────────────

export const aiFeedbackCreateResponseSchema = successSchema;

export const aiFeedbackSummaryItemSchema = z.object({
  feature: z.string(),
  up: z.number().int(),
  down: z.number().int(),
  total: z.number().int(),
  ratio: z.number().nullable(),
});
export const aiFeedbackSummaryResponseSchema = z.array(aiFeedbackSummaryItemSchema);

// ─── AI Summaries ──────────────────────────────────────────────────────────────

export const aiSummarySnapshotSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  summary: z.string(),
  structured: z.object({
    highlights: z.array(z.string()),
    blockers: z.array(z.string()),
    nextActions: z.array(z.string()),
  }).nullable(),
  citations: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    href: z.string().optional(),
    snippet: z.string().optional(),
    freshness: z.string().optional(),
  })).nullable(),
  correlationId: z.string().nullable(),
  generatedBy: z.string().nullable(),
  generatedByMembershipId: z.number().int().nullable(),
  createdAt: z.string(),
});

const snapshotFieldDiffSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
});
const snapshotDiffSchema = z.object({
  highlights: snapshotFieldDiffSchema,
  blockers: snapshotFieldDiffSchema,
  nextActions: snapshotFieldDiffSchema,
  isSameSnapshot: z.boolean(),
});
export const snapshotWithDiffResponseSchema = z.object({
  snapshot: aiSummarySnapshotSchema,
  diff: snapshotDiffSchema.nullable(),
});
export const snapshotWithDiffNullableResponseSchema = snapshotWithDiffResponseSchema.nullable();
export const aiSummariesSaveSnapshotResponseSchema = aiSummarySnapshotSchema;

// ─── AI Usage ─────────────────────────────────────────────────────────────────

export const aiUsageResponseSchema = z.object({
  totals: z.object({
    totalTokens: z.number(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  }),
  byFeature: z.array(z.object({
    feature: z.string(),
    model: z.string(),
    totalTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  })),
  daily: z.array(z.object({
    date: z.string(),
    totalTokens: z.number(),
    estimatedCostUsd: z.string(),
    requestCount: z.number().int(),
  })),
  performance: z.object({
    avgLatencyMs: z.number().nullable(),
    p95LatencyMs: z.number().nullable(),
    errorRate: z.number(),
  }),
  acceptance: z.object({
    feedbackByFeature: z.array(z.object({
      feature: z.string(),
      up: z.number().int(),
      down: z.number().int(),
      total: z.number().int(),
      ratio: z.number().nullable(),
    })),
    supportSuggestions: z.object({
      accepted: z.number().int(),
      rejected: z.number().int(),
      pending: z.number().int(),
    }),
  }),
});

// ─── Blog AI ──────────────────────────────────────────────────────────────────

export const blogImproveWritingResponseSchema = z.object({ content: z.string() });
export const blogSuggestTitleResponseSchema = z.object({ title: z.string() });
export const blogSummarizeResponseSchema = z.object({ excerpt: z.string() });

// ─── Chat Assistant ───────────────────────────────────────────────────────────

export const chatMessageSchema = z.object({
  id: z.number().int(),
  role: z.string(),
  content: z.string(),
  createdAt: z.string(),
});
export const chatHistoryResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
  nextCursor: z.number().int().nullable(),
});
export const chatClearHistoryResponseSchema = z.object({ success: z.literal(true) });
export const aiConversationSchema = z.object({
  id: z.number().int(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const listConversationsResponseSchema = z.object({
  conversations: z.array(aiConversationSchema),
  nextCursor: z.number().int().nullable(),
});
export const deleteConversationResponseSchema = z.object({ success: z.literal(true) });
export const confirmActionResponseSchema = z.object({
  ok: z.literal(true),
  result: z.record(z.string(), z.unknown()),
  summary: z.string(),
});

// ─── CRM AI ───────────────────────────────────────────────────────────────────

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

// ─── CRM Copilot ──────────────────────────────────────────────────────────────

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
const citationItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  href: z.string().optional(),
  snippet: z.string().optional(),
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

// ─── HR AI ────────────────────────────────────────────────────────────────────

export const attritionRiskResponseSchema = AttritionRiskSchema.extend(advisoryFields);
export const generateReviewResponseSchema = ReviewDraftSchema.extend(advisoryFields);
export const generateJdResponseSchema = z.object({ description: z.string() });
export const scoreCandidateResponseSchema = CandidateScoreSchema.extend(advisoryFields);
export const helpdeskReplyResponseSchema = HelpdeskReplySchema;
const policyEvidenceCitationSchema = z.object({
  policyId: z.number().int(),
  policyType: z.string(),
  policyName: z.string().nullable(),
  snippet: z.string(),
  path: z.string(),
  source: z.literal("hr_policy_registry"),
});
export const policyQaResponseSchema = PolicyQaSchema.extend({
  citations: z.array(policyEvidenceCitationSchema),
  suggestTicket: z.boolean(),
  capability: z.object({
    mode: z.literal("explain_draft_only"),
    mayInventPolicy: z.boolean(),
    mayApprovePayroll: z.boolean(),
    mayFileStatutory: z.boolean(),
    mayMoveMoney: z.boolean(),
    honestyLabel: z.string(),
    note: z.string(),
  }),
  forbiddenActions: z.array(z.string()),
  advisory: z.literal(true),
  disclaimer: z.string(),
});
export const policyQaCapabilitiesResponseSchema = z.object({
  mode: z.literal("explain_draft_only"),
  mayInventPolicy: z.boolean(),
  mayApprovePayroll: z.boolean(),
  mayFileStatutory: z.boolean(),
  mayMoveMoney: z.boolean(),
  honestyLabel: z.string(),
  note: z.string(),
  forbiddenActions: z.array(z.string()),
  features: z.array(z.object({
    key: z.string(),
    mode: z.string(),
    requiresHumanEscalationWhenNotFound: z.boolean(),
  })),
});
export const interviewKitResponseSchema = InterviewKitSchema.extend(advisoryFields);
export const letterDraftResponseSchema = LetterDraftSchema.extend(advisoryFields);
export const interviewNotesSummaryResponseSchema = InterviewNotesSummarySchema.extend(advisoryFields);
export const acceptCandidateScoreResponseSchema = z.object({ accepted: z.literal(true) });

// ─── KB RAG ───────────────────────────────────────────────────────────────────

const kbAnswerSourceSchema = z.object({
  articleId: z.number().int(),
  title: z.string(),
  slug: z.string(),
  attachmentId: z.number().int().nullable(),
  attachmentName: z.string().nullable(),
  similarity: z.number(),
});
export const kbAskResponseSchema = z.object({
  answer: z.string(),
  sources: z.array(kbAnswerSourceSchema),
  hasContext: z.boolean(),
});

// ─── Meetings AI ──────────────────────────────────────────────────────────────

export const meetingsPrepResponseSchema = z.object({
  agenda: agendaOutputSchema,
  connectedIntegrations: z.boolean(),
});
export const meetingsFollowUpResponseSchema = z.object({
  followUp: followUpOutputSchema,
  eventTitle: z.string(),
});
export const proposeSendFollowUpResponseSchema = z.object({
  proposalId: z.number().int(),
  token: z.string(),
  expiresAt: z.string(),
});
export const confirmSendFollowUpResponseSchema = z.union([
  z.object({ executed: z.literal(true), channel: z.string() }),
  z.object({ executed: z.literal(false), error: z.string(), message: z.string() }),
]);

// ─── Projects AI ──────────────────────────────────────────────────────────────

const projectEvidenceSchema = z.object({
  totalTasks: z.number().int(),
  done: z.number().int(),
  inProgress: z.number().int(),
  blocked: z.number().int(),
  overdue: z.number().int(),
});

export const projectSummaryResponseSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()),
  atRisk: z.boolean(),
  evidence: projectEvidenceSchema.extend({ sprintProgressPct: z.number().optional() }),
});
export const projectRisksResponseSchema = z.object({
  risks: z.array(z.object({
    title: z.string(),
    severity: z.enum(["low", "medium", "high", "critical"]),
    description: z.string(),
  })),
  evidence: projectEvidenceSchema,
});
export const projectClientUpdateResponseSchema = z.object({
  headline: z.string(),
  body: z.string(),
  sections: z.array(z.object({ heading: z.string(), content: z.string() })),
});
const ticketSuggestionSchema = z.object({
  title: z.string(),
  type: z.string(),
  priority: z.string(),
  description: z.string(),
});
export const projectPlanResponseSchema = z.object({
  goal: z.string(),
  tickets: z.array(ticketSuggestionSchema),
  suggestions: z.literal(true),
});
export const projectExtractTasksResponseSchema = z.object({
  tickets: z.array(ticketSuggestionSchema),
  suggestions: z.literal(true),
});
export const projectAskResponseSchema = z.object({
  answer: z.string(),
  evidence: z.object({
    totalTasks: z.number().int(),
    done: z.number().int(),
    inProgress: z.number().int(),
    blocked: z.number().int(),
    overdue: z.number().int(),
  }),
});
export const suggestDraftTitleResponseSchema = z.object({ title: z.string() });
export const improveDraftDescriptionResponseSchema = z.object({ description: z.string() });
const ticketPriorityEnum = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "URGENT"]);
export const suggestDraftFieldsResponseSchema = z.object({
  priority: ticketPriorityEnum.optional(),
  points: z.number().int().optional(),
  labelIds: z.array(z.number().int()),
  labelNames: z.array(z.string()),
  rationale: z.string(),
});
export const summarizeTicketResponseSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  actionItems: z.array(z.string()),
  sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
});
export const summarizeCommentsResponseSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  actionItems: z.array(z.string()),
});
export const improveTicketDescriptionResponseSchema = z.object({ description: z.string() });
export const suggestSubtasksResponseSchema = z.object({
  subtasks: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
  })),
});
export const generateChecklistResponseSchema = z.object({
  title: z.string(),
  items: z.array(z.object({
    text: z.string(),
    completed: z.boolean().optional(),
  })),
});
export const weeklyUpdateResponseSchema = z.object({
  headline: z.string(),
  body: z.string(),
  sections: z.array(z.object({ heading: z.string(), content: z.string() })).optional(),
  dateRange: z.object({ startDate: z.string(), endDate: z.string() }),
  suggestions: z.literal(true),
});
export const extractMeetingActionsResponseSchema = z.object({
  actions: z.array(z.object({
    title: z.string(),
    assignee: z.string().optional(),
    dueDate: z.string().optional(),
  })),
});
export const changeImpactResponseSchema = z.object({
  impact: z.string(),
  risks: z.array(z.string()),
  recommendations: z.array(z.string()),
  evidence: z.object({
    openChangeRequests: z.number().int(),
    openRisks: z.number().int(),
    pendingApprovals: z.number().int(),
  }),
});
export const ticketHandoffResponseSchema = z.object({
  summary: z.string(),
  openItems: z.array(z.string()),
  context: z.string(),
});

// ─── Survey AI ────────────────────────────────────────────────────────────────

export const surveyAiSummarizeResponseSchema = z.object({ summary: z.string() });

// ─── Executive Brief ──────────────────────────────────────────────────────────

const briefCitationSchema = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string(),
});
const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

const executiveBriefSnapshotSchema = z.object({
  narrative: z.string(),
  citations: z.array(briefCitationSchema),
  uncertaintyNotes: z.array(z.string()),
  generatedAt: z.string(),
  aiUsage: aiUsageMetaSchema.nullable(),
});
export const executiveBriefGetLatestResponseSchema = z.object({
  snapshot: executiveBriefSnapshotSchema.nullable(),
  isStale: z.boolean(),
  staleSinceMinutes: z.number().int().optional(),
});
export const executiveBriefGenerateResponseSchema = executiveBriefSnapshotSchema.extend({
  sources: z.record(z.string(), z.unknown()),
});
