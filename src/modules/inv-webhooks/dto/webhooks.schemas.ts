import { z } from "zod";

const WEBHOOK_EVENTS = [
  "inventory.product.created",
  "inventory.stock.changed",
  "inventory.stock.low",
  "inventory.po.created",
  "inventory.po.received",
  "inventory.so.reserved",
  "inventory.so.shipped",
  "inventory.transfer.completed",
  "inventory.adjustment.posted",
] as const;
export type WebhookEventType = typeof WEBHOOK_EVENTS[number];

export const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  isActive: z.boolean().optional().default(true),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export const listEventsQuerySchema = z.object({
  status: z.enum(["PENDING", "DELIVERED", "FAILED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListEventsQueryInput = z.infer<typeof listEventsQuerySchema>;
