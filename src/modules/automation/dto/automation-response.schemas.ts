import { z } from "zod";

/** `ActionResult` — `automation.service.ts`. */
const actionResultSchema = z.object({
  type: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

/** `automation.service.ts` `testRule` return. */
export const testAutomationResponseSchema = z.object({
  runId: z.number().int(),
  matched: z.boolean(),
  status: z.enum(["skipped", "success", "failed"]),
  actionResults: z.array(actionResultSchema),
});
