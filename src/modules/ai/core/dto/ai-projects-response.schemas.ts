import { z } from "zod";

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
  blockers: z.array(z.string()),
});

export const summarizeCommentsResponseSchema = z.object({
  summary: z.string(),
  themes: z.array(z.string()),
  openQuestions: z.array(z.string()),
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

const handoffCitationSchema = z.object({
  source: z.enum(["description", "comment", "decision"]),
  excerpt: z.string(),
});

export const ticketHandoffResponseSchema = z.object({
  currentState: z.string(),
  keyDecisions: z.array(z.string()),
  nextAction: z.string(),
  blockers: z.array(z.string()),
  citations: z.array(handoffCitationSchema),
});
