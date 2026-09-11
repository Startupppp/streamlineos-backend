import { z } from "zod";

export const gapDraftSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});
