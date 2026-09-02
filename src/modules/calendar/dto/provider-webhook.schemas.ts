import { z } from "zod";

export const providerWebhookBodySchema = z
  .object({
    connectionId: z.coerce.number().int().positive(),
    externalEventId: z.string().min(1).max(1024),
    providerUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ProviderWebhookBody = z.infer<typeof providerWebhookBodySchema>;
