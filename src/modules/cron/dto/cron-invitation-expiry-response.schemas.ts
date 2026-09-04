import { z } from "zod";

/**
 * The published response contract for `GET|POST /cron/invitation-expiry-sweep`.
 *
 * Two arms, mirroring `runSweep` in `cron-invitation-expiry.controller.ts`:
 * the lease was already held (skip), or the tick ran and reports the number of
 * invitations marked expired. `ResponseContractInterceptor` validates the real
 * handler return against this.
 */
export const invitationExpirySweepResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    skipped: z.literal(true),
    message: z.string(),
  }),
  z.object({
    success: z.literal(true),
    message: z.string(),
    expired: z.number().int().nonnegative(),
  }),
]);
