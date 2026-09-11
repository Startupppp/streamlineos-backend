import { z } from "zod";
import { wireDate } from "../../../../../common/openapi/wire-types";

/**
 * NEO-1 — `ChannelPoolRow` (`stock-engine/channel-pool.service.ts`).
 *
 * `reservedQty` and `publishedQty` are `decimal` columns and reach the wire as
 * exact strings; `warehouseId` is null for an org-wide claim, which is a
 * different thing from a claim pinned to a site nobody named.
 */
const channelPoolRowSchema = z.object({
  id: z.number().int(),
  channelId: z.number().int(),
  channelName: z.string(),
  warehouseId: z.number().int().nullable(),
  productVariantId: z.number().int(),
  reservedQty: z.string(),
  publishedQty: z.string(),
  updatedAt: wireDate(),
});

export const allocateChannelPoolResponseSchema = channelPoolRowSchema;
export const listChannelPoolsResponseSchema = z.array(channelPoolRowSchema);

/**
 * `ChannelAvailability` (`stock-engine/lib/channel-availability.ts`).
 *
 * `reservedByOthers` and `reservedForChannel` are reported separately on
 * purpose: "somebody else is holding it" and "you are already holding it" are
 * different answers to the same shortfall.
 */
export const channelPoolAvailabilityResponseSchema = z.object({
  productVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  available: z.string(),
  reservedByOthers: z.string(),
  reservedForChannel: z.string(),
  netAvailable: z.string(),
});
