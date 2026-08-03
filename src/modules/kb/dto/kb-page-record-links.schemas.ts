import { z } from "zod";

export const RECORD_LINK_TARGET_TYPES = [
  "crm_lead",
  "crm_deal",
  "crm_contact",
  "project",
  "project_ticket",
  "support_ticket",
  "hr_employee",
] as const;

export const createRecordLinkSchema = z.object({
  targetType: z.enum(RECORD_LINK_TARGET_TYPES),
  targetId: z.string().min(1).max(64),
  label: z.string().min(1).max(300),
});

export type CreateRecordLinkDto = z.infer<typeof createRecordLinkSchema>;

export const recordLinkByRecordQuerySchema = z.object({
  targetType: z.enum(RECORD_LINK_TARGET_TYPES),
  targetId: z.string().min(1).max(64),
});

export type RecordLinkByRecordQuery = z.infer<typeof recordLinkByRecordQuerySchema>;
