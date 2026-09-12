import { z } from "zod";

/**
 * B2 — the operations board.
 *
 * Every quantity and every value on these three surfaces is a decimal Postgres
 * aggregate cast `::text`, deliberately: `stockValue` is a figure somebody
 * reconciles against their accounts, and a float here is a rounding error in
 * it. Counts are `::int` and are genuine numbers.
 */
export const opsSummaryResponseSchema = z.object({
  quantities: z.object({
    onHand: z.string(),
    available: z.string(),
    reserved: z.string(),
    damaged: z.string(),
    quarantined: z.string(),
    picked: z.string(),
    /** Stock parked at a TRANSIT location — never `onOrder`, which is unshipped. */
    inTransit: z.string(),
    onOrder: z.string(),
  }),
  skuCount: z.number().int(),
  stockValue: z.string(),
  facilities: z.object({
    total: z.number().int(),
    darkStores: z.number().int(),
    zones: z.number().int(),
  }),
});

/**
 * `AttentionItem` (`lib/attention-board.ts`). A card whose probe failed is
 * dropped rather than rendered as zero, so every item here is a count somebody
 * should act on. `actionLabel` is null when the link is the whole action.
 */
export const opsAttentionResponseSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      severity: z.enum(["critical", "warning", "info"]),
      title: z.string(),
      detail: z.string(),
      count: z.number().int(),
      href: z.string(),
      actionLabel: z.string().nullable(),
    }),
  ),
  generatedAt: z.string(),
});

/** One row per facility in the caller's scope, zone-ordered with nulls last. */
export const opsZoneBoardResponseSchema = z.array(
  z.object({
    warehouseId: z.number().int(),
    name: z.string(),
    code: z.string(),
    facilityType: z.string(),
    zone: z.string().nullable(),
    zoneLabel: z.string().nullable(),
    city: z.string().nullable(),
    deliveryPromiseMinutes: z.number().int().nullable(),
    isActive: z.boolean(),
    skuCount: z.number().int(),
    onHand: z.string(),
    reserved: z.string(),
    damaged: z.string(),
    quarantined: z.string(),
    picked: z.string(),
    inTransit: z.string(),
    available: z.string(),
    stockValue: z.string(),
    outOfStockSkus: z.number().int(),
  }),
);
