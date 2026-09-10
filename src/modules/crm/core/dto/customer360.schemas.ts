import { z } from "zod";

export const timelineQuerySchema = z.object({
  cursor: z.string().optional(),
});
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
