import { z } from "zod";

export const visitSchema = z.object({
  sessionToken: z.string().min(1).max(64),
  path: z.string().min(1).max(500),
  referrer: z.string().max(500).nullish(),
});

export type VisitInput = z.infer<typeof visitSchema>;
