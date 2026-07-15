import { z } from "zod";

export const improveDescriptionBodySchema = z.object({
  draft: z.string().max(5000).optional(),
});
export type ImproveDescriptionBodyInput = z.infer<typeof improveDescriptionBodySchema>;

export const TicketSummaryOutputSchema = z.object({
  summary: z.string().describe("2-3 sentence summary of the ticket"),
  keyPoints: z.array(z.string()).describe("Up to 5 key points about this ticket"),
  blockers: z.array(z.string()).describe("Current blockers or impediments, empty if none"),
});
export type TicketSummaryOutput = z.infer<typeof TicketSummaryOutputSchema>;

const SubtaskSuggestionSchema = z.object({
  title: z.string().describe("Concise subtask title"),
});

export const TicketSubtasksOutputSchema = z.object({
  subtasks: z.array(SubtaskSuggestionSchema).describe("3-7 suggested subtask titles, deduplicated against existing ones"),
});
export type TicketSubtasksOutput = z.infer<typeof TicketSubtasksOutputSchema>;
