import { z } from "zod";

/**
 * G3 — what the expiry sweep reports.
 *
 * One number, and deliberately only one: the all-tenant variant also returns an
 * `organizations` count, and that figure discloses the size of the platform, so
 * it is not reachable over HTTP and has no shape here.
 */
export const expirySweepResponseSchema = z.object({
  events: z.number().int(),
});
