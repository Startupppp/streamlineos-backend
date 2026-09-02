import { z } from "zod";

export const collectorTypeSchema = z.enum([
  "public_link",
  "email",
  "qr",
  "embed",
  "popup",
  "crm_campaign",
  "hr_audience",
  "support_trigger",
  "live_session",
  "manual_access_code",
]);

export const createCollectorSchema = z.object({
  collectorType: collectorTypeSchema,
  name: z.string().min(1).max(200),
  source: z.string().max(200).optional(),
  utm: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.coerce.date().optional(),
}).strict();

export const patchCollectorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "paused", "closed", "expired"]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
}).strict();

export type CreateCollectorInput = z.infer<typeof createCollectorSchema>;
export type PatchCollectorInput = z.infer<typeof patchCollectorSchema>;
