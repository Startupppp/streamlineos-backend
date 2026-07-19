import { z } from "zod";

const CHANNELS = [
  "IN_APP",
  "EMAIL",
  "PUSH",
  "SMS",
  "WHATSAPP",
  "WEBHOOK",
] as const;
const PROVIDERS = [
  "SMTP",
  "TWILIO",
  "META_WHATSAPP",
  "WEBHOOK",
  "WEB_PUSH",
  "INTERNAL",
  "SANDBOX",
] as const;

export const createProviderSchema = z.object({
  channel: z.enum(CHANNELS),
  provider: z.enum(PROVIDERS),
  displayName: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional().default(true),
  sandboxMode: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
  dailySendLimit: z.number().int().positive().nullable().optional(),
  monthlyCostLimit: z.number().int().positive().nullable().optional(),
});

export const updateProviderSchema = createProviderSchema
  .partial()
  .omit({ channel: true, provider: true });

export const testProviderSchema = z.object({
  to: z.string().max(320).optional(),
});

export type CreateProviderInput = z.infer<typeof createProviderSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;
export type TestProviderInput = z.infer<typeof testProviderSchema>;
