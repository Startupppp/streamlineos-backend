import { z } from "zod";
import { signAuthMethodSchema } from "./e-sign.schemas";

export const updateSignSettingsSchema = z.object({
  defaultExpirationDays: z.number().int().min(1).max(365).optional(),
  expirationWarningDays: z.number().int().min(0).max(60).optional(),
  defaultReminderFirstAfterDays: z.number().int().min(1).max(90).optional(),
  defaultReminderRepeatDays: z.number().int().min(1).max(90).optional(),
  defaultReminderMaxCount: z.number().int().min(0).max(20).optional(),
  allowedFileTypes: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  maxFileSizeMb: z.number().int().min(1).max(200).optional(),
  allowedAuthMethods: z.array(signAuthMethodSchema).max(20).optional(),
  certificateFormat: z.string().trim().max(20).optional(),
  bulkSendMaxRowsPerJob: z.number().int().min(1).max(10000).optional(),
  bulkSendMaxActiveJobs: z.number().int().min(1).max(100).optional(),
  bulkSendMaxRecipientsPerEnvelope: z.number().int().min(1).max(500).optional(),
  senderRateLimitPerHour: z.number().int().min(1).max(10000).optional(),
  brandingJson: z
    .object({
      logoUrl: z.string().trim().url().optional(),
      emailSenderName: z.string().trim().max(150).optional(),
      emailAccentColor: z.string().trim().max(20).optional(),
      signingPageLogoUrl: z.string().trim().url().optional(),
      signingPageSupportText: z.string().trim().max(1000).optional(),
      completionMessage: z.string().trim().max(1000).optional(),
      disclosureText: z.string().trim().max(5000).optional(),
      disclosureVersion: z.string().trim().max(50).optional(),
    })
    .partial()
    .optional(),
  webhookUrl: z.string().trim().url().optional(),
}).strict();
export type UpdateSignSettingsInput = z.infer<typeof updateSignSettingsSchema>;

export const watermarkPolicyInputSchema = z.object({
  scopeType: z.enum(["tenant", "template", "envelope"]),
  scopeId: z.number().int().positive().optional(),
  appliesStates: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  text: z.string().trim().max(200).optional(),
  opacity: z.number().int().min(0).max(100).default(30),
  angle: z.number().int().min(-180).max(180).default(45),
  color: z.string().trim().max(20).default("#94A3B8"),
  fontSize: z.number().int().min(6).max(200).default(36),
  placement: z.string().trim().max(50).default("diagonal_tiled"),
  pages: z
    .object({ mode: z.enum(["all", "first", "custom"]), pageNumbers: z.array(z.number().int().min(1)).max(500).optional() })
    .default({ mode: "all" }),
  showOnFinalPdf: z.boolean().default(true),
  previewOnly: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).strict();
export type WatermarkPolicyInput = z.infer<typeof watermarkPolicyInputSchema>;

/** `GET /sign/admin/sweep-preview`: which sweep to rehearse, defaulting to the reminder pass. */
export const sweepPreviewQuerySchema = z
  .object({ sweep: z.enum(["reminder", "expiration"]).default("reminder") })
  .strict();
export type SweepPreviewQuery = z.infer<typeof sweepPreviewQuerySchema>;
