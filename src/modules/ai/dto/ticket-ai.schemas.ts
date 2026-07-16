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

export const extractMeetingActionsBodySchema = z.object({});
export type ExtractMeetingActionsBodyInput = z.infer<typeof extractMeetingActionsBodySchema>;

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
export type MeetingExtractActionsOutput = z.infer<typeof MeetingExtractActionsOutputSchema>;

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
export type TicketHandoffOutput = z.infer<typeof TicketHandoffOutputSchema>;
