import { z } from "zod";

/**
 * INV-207 — what a carrier is permitted to assert.
 *
 * Strict and closed, for the same reason the AI contract is: nothing a third
 * party sends may become a route, an identity or an authority. In particular
 * the payload names a *tracking number*, never a shipment id -- the shipment is
 * resolved from our own records inside the caller's tenant, so a webhook cannot
 * name a shipment belonging to somebody else.
 */
export const carrierStatusSchema = z
  .object({
    trackingNumber: z.string().min(1).max(200),
    status: z.enum(["LABEL_CREATED", "SHIPPED", "DELIVERED", "CANCELLED"]),
    /** When the carrier says it happened, which is not when we heard. */
    occurredAt: z.string().datetime(),
    /**
     * The carrier's own id for this event. Optional, because not every carrier
     * sends one -- but without it the event cannot be deduplicated and a replay
     * will be recorded twice.
     */
    carrierEventId: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    rawPayload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CarrierStatusInput = z.infer<typeof carrierStatusSchema>;
