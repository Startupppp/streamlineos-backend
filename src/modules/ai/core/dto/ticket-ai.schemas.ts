import { z } from "zod";

export const DESCRIPTION_MAX = 100_000;

export const improveDescriptionBodySchema = z.object({
  draft: z.string().max(DESCRIPTION_MAX).optional(),
}).strict();
export type ImproveDescriptionBodyInput = z.infer<typeof improveDescriptionBodySchema>;

export const draftTicketBodySchema = z
  .object({
    title: z.string().max(500).optional(),
    description: z.string().max(DESCRIPTION_MAX).optional(),
  }).strict()
  .refine(
    (data) => Boolean(data.title?.trim() || data.description?.trim()),
    { message: "Provide a title or description" },
  );
export type DraftTicketBodyInput = z.infer<typeof draftTicketBodySchema>;

export const TicketSuggestTitleOutputSchema = z.object({
  title: z.string().describe("Concise issue title, max 120 characters"),
});

export const TicketSuggestFieldsOutputSchema = z.object({
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).describe("Suggested priority"),
  points: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .describe("Suggested story-point estimate, or null if unclear"),
  labelNames: z
    .array(z.string())
    .max(5)
    .describe("Up to 5 labels chosen ONLY from the provided available labels list"),
  rationale: z.string().describe("1-2 sentence rationale for the suggestions"),
});

export const TicketSummaryOutputSchema = z.object({
  summary: z.string().describe("2-3 sentence summary of the ticket"),
  keyPoints: z.array(z.string()).describe("Up to 5 key points about this ticket"),
  blockers: z.array(z.string()).describe("Current blockers or impediments, empty if none"),
});

export const TicketCommentsSummaryOutputSchema = z.object({
  summary: z.string().describe("2-4 sentence summary of the comment thread"),
  themes: z.array(z.string()).describe("Up to 5 recurring themes or topics from comments"),
  openQuestions: z.array(z.string()).describe("Unresolved questions raised in comments, empty if none"),
});

const SubtaskSuggestionSchema = z.object({
  title: z.string().describe("Concise subtask title"),
});

export const TicketSubtasksOutputSchema = z.object({
  subtasks: z.array(SubtaskSuggestionSchema).describe("3-7 suggested subtask titles, deduplicated against existing ones"),
});

const ChecklistItemSuggestionSchema = z.object({
  text: z.string().describe("Concise checklist item, actionable and verifiable"),
});

export const TicketChecklistOutputSchema = z.object({
  title: z.string().describe("Short checklist title summarizing the work, max 80 characters"),
  items: z
    .array(ChecklistItemSuggestionSchema)
    .describe("4-10 checklist items tailored to the ticket, deduplicated against existing items"),
});

const ProposedActionItemSchema = z.object({
  title: z.string().describe("Action item title, max 200 chars"),
  ownerName: z.string().describe("Resolved assignee name from the notes, empty string if unclear"),
  dueDateHint: z.string().describe("Due date extracted from notes in YYYY-MM-DD or relative text, empty string if none"),
  rationale: z.string().describe("1-sentence reason this is an action item"),
});

export const MeetingExtractActionsOutputSchema = z.object({
  actions: z.array(ProposedActionItemSchema).describe("Proposed action items, max 10, deduplicated"),
  summary: z.string().describe("1-2 sentence summary of the meeting notes"),
});

const HandoffCitationSchema = z.object({
  source: z.enum(["description", "comment", "decision"]),
  excerpt: z.string().describe("Short excerpt (max 100 chars) from the source"),
});

export const TicketHandoffOutputSchema = z.object({
  currentState: z.string().describe("2-3 sentences on what state the work is in"),
  keyDecisions: z.array(z.string()).describe("Up to 3 key decisions or design choices made"),
  nextAction: z.string().describe("Concrete next step the next person should take"),
  blockers: z.array(z.string()).describe("Current blockers, empty if none"),
  citations: z.array(HandoffCitationSchema).describe("Citations from ticket data"),
});
