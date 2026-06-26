import { z } from "zod";

export const syncInterviewSchema = z.object({
  interviewId: z.number().int().positive(),
});

export type SyncInterviewInput = z.infer<typeof syncInterviewSchema>;
