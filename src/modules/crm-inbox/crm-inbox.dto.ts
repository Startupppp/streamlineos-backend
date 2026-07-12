import { z } from "zod";

export const snoozeTaskSchema = z.object({
  until: z.string().datetime({ message: "until must be a valid ISO datetime" }),
});

export type SnoozeTaskInput = z.infer<typeof snoozeTaskSchema>;
