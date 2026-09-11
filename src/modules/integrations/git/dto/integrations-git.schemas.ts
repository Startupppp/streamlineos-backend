import { z } from "zod";

export const webhookQuerySchema = z
  .object({
    connectionId: z.string().min(1).optional(),
  })
  .strict();

type WebhookQuery = z.infer<typeof webhookQuerySchema>;
