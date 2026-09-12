import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

/**
 * NEO-4 — `HandlingUnitContentRow` (`lib/handling-unit-tree.ts`).
 *
 * `ownership` is declared because INV-18 turns on it: it is part of
 * `inv_stock_levels`' natural key, and a read that dropped it made a pallet of
 * a supplier's cartons indistinguishable from a pallet of our own.
 */
const handlingUnitContentSchema = z.object({
  productVariantId: z.number().int(),
  lotId: z.number().int().nullable(),
  serialId: z.number().int().nullable(),
  handlingUnitId: z.number().int(),
  ownership: z.enum(["OWNED", "VENDOR", "CUSTOMER"]),
  onHand: z.string(),
});

/**
 * `HandlingUnitDetail`. `contents` is what sits on this unit alone and is
 * always empty for a parent; `rolledUpContents` adds every descendant's, which
 * is what the label on the outside actually means.
 */
export const handlingUnitDetailResponseSchema = z.object({
  id: z.number().int(),
  huCode: z.string(),
  kind: z.string(),
  status: z.string(),
  locationId: z.number().int().nullable(),
  parentHuId: z.number().int().nullable(),
  childIds: z.array(z.number().int()),
  contents: z.array(handlingUnitContentSchema),
  rolledUpContents: z.array(handlingUnitContentSchema),
});

/** The list's own projection — no contents, because it is capped at 100 units. */
export const listHandlingUnitsResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    huCode: z.string(),
    kind: z.string(),
    status: z.string(),
    locationId: z.number().int().nullable(),
    parentHuId: z.number().int().nullable(),
    updatedAt: wireDate(),
  }),
);
