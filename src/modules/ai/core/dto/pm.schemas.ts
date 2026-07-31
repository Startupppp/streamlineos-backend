import { z } from "zod";

export const planBodySchema = z.object({
  prompt: z.string().min(1).max(2000),
});
export type PlanBodyInput = z.infer<typeof planBodySchema>;

export const extractBodySchema = z.object({
  text: z.string().min(1).max(8000),
});
export type ExtractBodyInput = z.infer<typeof extractBodySchema>;

export const askBodySchema = z.object({
  question: z.string().min(1).max(1000),
});
export type AskBodyInput = z.infer<typeof askBodySchema>;

export const PmSummaryOutputSchema = z.object({
  summary: z.string().describe("2-3 sentence project health summary"),
  highlights: z.array(z.string()).describe("Up to 3 notable progress points"),
  atRisk: z.boolean().describe("Whether the project risks missing its goals"),
});
export type PmSummaryOutput = z.infer<typeof PmSummaryOutputSchema>;

const RiskItemSchema = z.object({
  title: z.string().describe("Short risk title, max 10 words"),
  severity: z.enum(["high", "medium", "low"]),
  rationale: z.string().describe("1-2 sentence explanation"),
  mitigation: z.string().describe("Concrete mitigation action"),
});

export const PmRisksOutputSchema = z.object({
  risks: z.array(RiskItemSchema).describe("Identified risks ordered by severity"),
});
export type PmRisksOutput = z.infer<typeof PmRisksOutputSchema>;

const ClientUpdateSectionSchema = z.object({
  heading: z.string(),
  content: z.string().describe("Client-safe content only"),
});

export const PmClientUpdateOutputSchema = z.object({
  headline: z.string().describe("One-line status headline for the client"),
  body: z.string().describe("2-3 paragraph narrative, max 300 words, no internal data"),
  sections: z.array(ClientUpdateSectionSchema).describe("Optional structured sections"),
});
export type PmClientUpdateOutput = z.infer<typeof PmClientUpdateOutputSchema>;

const PlanTaskSchema = z.object({
  title: z.string().describe("Task title"),
  estimateHours: z.number().describe("Estimated effort in hours"),
  priority: z.enum(["high", "medium", "low"]),
});

const PlanMilestoneSchema = z.object({
  name: z.string().describe("Milestone name"),
  tasks: z.array(PlanTaskSchema).describe("Suggested tasks under this milestone"),
});

export const PmPlanOutputSchema = z.object({
  summary: z.string().describe("Brief plan summary, 1-2 sentences"),
  milestones: z.array(PlanMilestoneSchema).describe("Suggested milestones with tasks (2-5 milestones)"),
});
export type PmPlanOutput = z.infer<typeof PmPlanOutputSchema>;

const ExtractedTaskSchema = z.object({
  title: z.string().describe("Extracted task title"),
  priority: z.enum(["high", "medium", "low"]),
  suggestedAssignee: z.string().describe("Name or role hint for assignee, empty string if unclear"),
  dueHint: z.string().describe("Informal due date hint extracted from text, empty string if not mentioned"),
});

export const PmExtractOutputSchema = z.object({
  tasks: z.array(ExtractedTaskSchema).describe("Candidate tasks extracted, deduplicated against existing tickets"),
});
export type PmExtractOutput = z.infer<typeof PmExtractOutputSchema>;

export const PmAskOutputSchema = z.object({
  answer: z.string().describe("Direct answer to the question, 2-4 sentences"),
  confidence: z.enum(["high", "medium", "low"]).describe("Confidence based on data quality"),
});
export type PmAskOutput = z.infer<typeof PmAskOutputSchema>;

export const weeklyUpdateBodySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
});
export type WeeklyUpdateBodyInput = z.infer<typeof weeklyUpdateBodySchema>;

const WeeklyUpdateCitationSchema = z.object({
  source: z.enum(["ticket", "blocker", "risk", "decision", "discussion"]),
  label: z.string(),
});

export const PmWeeklyUpdateOutputSchema = z.object({
  headline: z.string().describe("One-line headline for the week, max 15 words"),
  completedHighlights: z.array(z.string()).describe("Up to 5 completed work highlights, each referencing real data"),
  blockers: z.array(z.string()).describe("Current blockers, max 3"),
  upcomingFocus: z.array(z.string()).describe("Top 2-3 things to focus on next week"),
  citations: z.array(WeeklyUpdateCitationSchema).describe("Data sources cited in the draft"),
});
export type PmWeeklyUpdateOutput = z.infer<typeof PmWeeklyUpdateOutputSchema>;

export const PmChangeImpactOutputSchema = z.object({
  headline: z.string().describe("One-line impact summary, max 15 words"),
  scopeImpact: z.string().describe("2-3 sentence scope impact analysis"),
  scheduleImpact: z.string().describe("2-3 sentence schedule/timeline impact"),
  budgetImpact: z.string().describe("2-3 sentence budget impact, use 'none identified' if not applicable"),
  riskSummary: z.array(z.string()).describe("Up to 3 key risk bullet points introduced by the changes"),
  pendingApprovals: z.array(z.string()).describe("Titles of approvals still pending, empty if none"),
  citations: z.array(z.object({ source: z.enum(["change_request", "risk", "approval", "plan"]), label: z.string() })).describe("Sources cited"),
});
export type PmChangeImpactOutput = z.infer<typeof PmChangeImpactOutputSchema>;
