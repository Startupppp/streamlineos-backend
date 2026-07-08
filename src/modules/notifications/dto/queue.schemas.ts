import { z } from "zod";

const CHANNELS = ["IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "SLACK", "TEAMS", "WEBHOOK"] as const;
const STATUSES = ["PENDING", "QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "CLICKED", "FAILED", "BOUNCED", "SUPPRESSED", "CANCELLED", "DEAD"] as const;

export const queueListSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  cursor: z.coerce.number().optional(),
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(STATUSES).optional(),
  eventKey: z.string().optional(),
});

export type QueueListInput = z.infer<typeof queueListSchema>;

export const bulkRetrySchema = z.object({
  ids: z.array(z.coerce.number()).min(1).max(100),
});

export type BulkRetryInput = z.infer<typeof bulkRetrySchema>;
