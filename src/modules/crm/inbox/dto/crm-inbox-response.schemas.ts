import { z } from "zod";
import { successSchema } from "../../../../common/openapi/response-envelopes";

const inboxItemSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  title: z.string(),
  entityType: z.enum(["lead", "deal", "task"]),
  entityId: z.number().int(),
  dueAt: z.string().nullable(),
  assigneeName: z.string().nullable(),
  assigneeId: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
});

const inboxSectionSchema = z.object({
  key: z.string(),
  items: z.array(inboxItemSchema),
  total: z.number().int(),
});

export const inboxResponseSchema = z.object({
  sections: z.array(inboxSectionSchema),
  aiActions: z.array(z.record(z.string(), z.unknown())),
});

export const inboxCountsSchema = z.object({
  dueTasks: z.number().int(),
  overdueTasks: z.number().int(),
  slaRisk: z.number().int(),
  stuckDeals: z.number().int(),
  followUpsDue: z.number().int(),
  newReplies: z.number().int(),
  meetingsToday: z.number().int(),
  newlyAssigned: z.number().int(),
});

export { successSchema };
