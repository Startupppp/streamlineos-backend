import { z } from "zod";

/**
 * INV-27 — what an operator may ask the channel seam to do.
 *
 * Every schema is `.strict()`, so a body carrying a field this product does not
 * have is a 400 rather than a silently ignored instruction. That matters more
 * than usual here: these payloads are copied verbatim into `inv_channel_jobs.request`
 * and replayed by a sweep that runs later, so an ignored field would be an
 * instruction somebody believes they gave.
 */

export const channelIdParamsSchema = z
  .object({ channelId: z.coerce.number().int().positive() })
  .strict();

export const jobIdParamsSchema = z
  .object({ jobId: z.coerce.number().int().positive() })
  .strict();

/**
 * How far back to ask the channel for orders.
 *
 * Optional, and absent means "everything the channel will show us". That is the
 * right default for a first import and a bad one for the hundredth, which is why
 * the response reports how many orders were already imported: an operator who
 * sees 400 duplicates and 2 new knows to start passing `since`.
 */
export const pullOrdersSchema = z
  .object({
    since: z.string().datetime().optional(),
  })
  .strict();

/**
 * Telling the channel a parcel left.
 *
 * `externalOrderId` is the channel's own order id, not ours: it is what the
 * marketplace will accept and it is the job's natural key. The sales order is
 * named too, because the confirmation is *about* one of our orders and an
 * operator reading the dead-letter row needs to be able to find it.
 *
 * Lines are required and carry SKUs rather than our variant ids — a channel has
 * never heard of an `inv_product_variants.id`.
 */
export const confirmShipmentSchema = z
  .object({
    externalOrderId: z.string().trim().min(1).max(200),
    salesOrderId: z.number().int().positive(),
    trackingNumber: z.string().trim().min(1).max(200).nullable().default(null),
    carrierName: z.string().trim().min(1).max(200).nullable().default(null),
    trackingUrl: z.string().url().max(2_000).nullable().default(null),
    lines: z
      .array(
        z
          .object({
            sku: z.string().trim().min(1).max(200),
            quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, "quantity must be a non-negative decimal"),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

/** The dead-letter screen's filters. Capped at the house maximum of 100. */
export const listChannelFailuresSchema = z
  .object({
    status: z.enum(["FAILED", "DEAD"]).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export type PullOrdersInput = z.infer<typeof pullOrdersSchema>;
export type ConfirmShipmentInput = z.infer<typeof confirmShipmentSchema>;
export type ListChannelFailuresInput = z.infer<typeof listChannelFailuresSchema>;
