import { z } from "zod";

export const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
  secret: z.string().optional(),
}).strict();

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  isActive: z.boolean(),
}).strict();

export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export const listWebhooksQuerySchema = z.object({
  state: z.enum(["active", "inactive"]).optional(),
  event: z.string().optional(),
  q: z.string().optional(),
  cursor: z.coerce.number().int().positive().optional(),
}).strict();

export type ListWebhooksQuery = z.infer<typeof listWebhooksQuerySchema>;
