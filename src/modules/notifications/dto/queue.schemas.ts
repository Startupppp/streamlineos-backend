import { z } from "zod";

export const queueListSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  cursor: z.coerce.number().optional(),
});

export type QueueListInput = z.infer<typeof queueListSchema>;
