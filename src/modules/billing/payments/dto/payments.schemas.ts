import { z } from "zod";

export const createProviderSchema = z.object({
  providerKey: z.string().min(1),
});
export type CreateProviderInput = z.infer<typeof createProviderSchema>;

export const updateProviderSchema = z.object({
  isPrimary: z.boolean().optional(),
  supportedCurrencies: z.array(z.string()).optional(),
  supportedPaymentMethods: z.array(z.string()).optional(),
});
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;

export const saveCredentialsSchema = z.object({
  environment: z.enum(["test", "live"]),
  keyId: z.string().min(1).optional(),
  secret: z.string().min(1).optional(),
  webhookSecret: z.string().min(1).optional(),
});
export type SaveCredentialsInput = z.infer<typeof saveCredentialsSchema>;

export const disconnectCredentialsSchema = z.object({
  environment: z.enum(["test", "live"]),
});
export type DisconnectCredentialsInput = z.infer<typeof disconnectCredentialsSchema>;
