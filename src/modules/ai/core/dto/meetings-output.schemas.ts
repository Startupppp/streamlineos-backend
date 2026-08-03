import { z } from "zod";

export const citationSchema = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
});

export const agendaOutputSchema = z.object({
  agenda: z.string(),
  keyTopics: z.array(z.string()),
  suggestedDuration: z.string().optional(),
  preparationNotes: z.string().optional(),
  citations: z.array(citationSchema),
});
export type AgendaOutput = z.infer<typeof agendaOutputSchema>;

export const followUpOutputSchema = z.object({
  subject: z.string(),
  body: z.string(),
  actionItems: z.array(z.object({
    item: z.string(),
    assignee: z.string().optional(),
    dueDate: z.string().optional(),
  })),
  nextMeetingDate: z.string().optional(),
});
export type FollowUpOutput = z.infer<typeof followUpOutputSchema>;
