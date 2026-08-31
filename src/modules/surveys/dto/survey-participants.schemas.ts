import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

export const participantInputSchema = z.object({
  name: z.string().max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  userId: z.string().optional(),
  contactId: z.number().int().positive().optional(),
  leadId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const importParticipantsSchema = z.object({
  collectorId: z.number().int().positive().optional(),
  participants: z.array(participantInputSchema).min(1).max(2000),
});

export const inviteParticipantsSchema = z.object({
  participantIds: z.array(z.number().int().positive()).min(1).max(2000),
});

export const remindParticipantsSchema = z.object({
  participantIds: z.array(z.number().int().positive()).min(1).max(2000),
});

export const listParticipantsSchema = z.object({
  status: z.enum(["invited", "delivered", "opened", "started", "partial", "completed", "disqualified", "bounced", "unsubscribed", "expired"]).optional(),
  page: pageNumberField,
  pageSize: pageSizeField(25, 100),
});

export type ImportParticipantsInput = z.infer<typeof importParticipantsSchema>;
export type InviteParticipantsInput = z.infer<typeof inviteParticipantsSchema>;
export type RemindParticipantsInput = z.infer<typeof remindParticipantsSchema>;
export type ListParticipantsInput = z.infer<typeof listParticipantsSchema>;
