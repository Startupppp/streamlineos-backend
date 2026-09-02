import { z } from "zod";

export const createProviderSchema = z.object({
  providerKey: z.string().min(1).max(50),
}).strict();
export type CreateProviderInput = z.infer<typeof createProviderSchema>;

export const updateProviderSchema = z.object({
  isPrimary: z.boolean().optional(),
  supportedCurrencies: z.array(z.string().length(3)).max(50).optional(),
  supportedPaymentMethods: z.array(z.string().min(1).max(50)).max(50).optional(),
}).strict();
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;

// At least one credential must be present: an empty save writes nothing but still stamps
// `lastRotatedAt`, so the audit trail would report a rotation that never happened.
export const saveCredentialsSchema = z.object({
  environment: z.enum(["test", "live"]),
  keyId: z.string().min(1).max(255).optional(),
  secret: z.string().min(1).max(1024).optional(),
  webhookSecret: z.string().min(1).max(1024).optional(),
}).strict().refine(
  (v) => v.keyId !== undefined || v.secret !== undefined || v.webhookSecret !== undefined,
  { message: "Provide at least one of keyId, secret or webhookSecret" },
);
export type SaveCredentialsInput = z.infer<typeof saveCredentialsSchema>;

export const disconnectCredentialsSchema = z.object({
  environment: z.enum(["test", "live"]),
}).strict();
export type DisconnectCredentialsInput = z.infer<typeof disconnectCredentialsSchema>;
