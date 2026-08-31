import { z } from "zod";

export const webhookQuerySchema = z.object({
  connectionId: z.string().optional(),
});

export type WebhookQuery = z.infer<typeof webhookQuerySchema>;
