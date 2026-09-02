import { z } from "zod";

export const meetingPrepBodySchema = z.object({
  eventId: z.string().min(1),
  includeCrmContext: z.boolean().optional().default(false),
  includeProjectContext: z.boolean().optional().default(false),
}).strict();
export type MeetingPrepBodyInput = z.infer<typeof meetingPrepBodySchema>;

export const meetingFollowUpBodySchema = z.object({
  eventId: z.string().min(1),
  meetingNotes: z.string().max(4000).optional(),
  actionItems: z.array(z.string().max(200)).max(20).optional(),
}).strict();
export type MeetingFollowUpBodyInput = z.infer<typeof meetingFollowUpBodySchema>;

export const meetingSendConfirmBodySchema = z.object({
  token: z.string().min(1),
}).strict();
export type MeetingSendConfirmBodyInput = z.infer<typeof meetingSendConfirmBodySchema>;

export const proposeSendBodySchema = z.object({
  eventId: z.string().min(1),
  followUpDraft: z.object({
    subject: z.string(),
    body: z.string(),
    actionItems: z.array(z.object({
      item: z.string(),
      assignee: z.string().optional(),
      dueDate: z.string().optional(),
    })),
    nextMeetingDate: z.string().optional(),
  }),
  channel: z.enum(["calendar", "none"]).default("none"),
}).strict();
export type ProposeSendBodyInput = z.infer<typeof proposeSendBodySchema>;
