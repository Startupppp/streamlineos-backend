import { z } from "zod";

const RETENTION_DAYS_PRESET = [30, 60, 90, 180, 365] as const;
type RetentionDaysPreset = (typeof RETENTION_DAYS_PRESET)[number];

function isRetentionDaysPreset(v: number): v is RetentionDaysPreset {
  return (RETENTION_DAYS_PRESET as readonly number[]).includes(v);
}

const retentionDaysPresetSchema = z
  .number()
  .int()
  .positive()
  .refine(isRetentionDaysPreset, {
    message: "Retention days must be one of 30, 60, 90, 180, or 365",
  })
  .nullable();

export const projectRetentionSettingsResponseSchema = z.object({
  projectId: z.number().int(),
  inheritOrgPolicy: z.boolean(),
  closedTicketRetentionDays: retentionDaysPresetSchema,
  attachmentRetentionDays: retentionDaysPresetSchema,
  auditLogRetentionDays: retentionDaysPresetSchema,
  legalHold: z.boolean(),
  legalHoldReason: z.string().nullable(),
  legalHoldSetAt: z.string().nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
});

export const updateRetentionPolicySchema = z
  .object({
    inheritOrgPolicy: z.boolean(),
    closedTicketRetentionDays: retentionDaysPresetSchema,
    attachmentRetentionDays: retentionDaysPresetSchema,
    auditLogRetentionDays: retentionDaysPresetSchema,
  })
  .strict();

export const setLegalHoldSchema = z
  .object({
    active: z.boolean(),
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();

export type UpdateRetentionPolicyInput = z.infer<typeof updateRetentionPolicySchema>;
export type SetLegalHoldInput = z.infer<typeof setLegalHoldSchema>;
export type ProjectRetentionSettingsRow = z.infer<
  typeof projectRetentionSettingsResponseSchema
>;
