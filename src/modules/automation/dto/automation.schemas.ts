import { z } from "zod";

export const testAutomationSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type TestAutomationInput = z.infer<typeof testAutomationSchema>;
