import { z } from "zod";

export const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().optional(),
}).strict();

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
