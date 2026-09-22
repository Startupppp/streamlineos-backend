import { z } from "zod";

export const submitChangeRequestSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
}).strict();

export type SubmitChangeRequestInput = z.infer<typeof submitChangeRequestSchema>;
