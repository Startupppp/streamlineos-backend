import { z } from "zod";

/**
 * E7 — what one delivery tick did, `WebhookDeliverySweepResult`.
 *
 * Eight counters rather than a success flag, because the sweep's failure modes
 * are what a scheduler has to be able to see: a tick that claims work and
 * delivers none looks identical to an idle one unless the counts are separate,
 * and `fenced` and `orphaned` are the two that say a lease went wrong rather
 * than a customer's endpoint.
 */
export const webhookDeliverySweepResponseSchema = z.object({
  claimed: z.number().int(),
  delivered: z.number().int(),
  retried: z.number().int(),
  dead: z.number().int(),
  alerted: z.number().int(),
  disabled: z.number().int(),
  fenced: z.number().int(),
  orphaned: z.number().int(),
});
