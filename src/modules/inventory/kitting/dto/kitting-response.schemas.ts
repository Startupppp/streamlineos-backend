import { z } from "zod";

/**
 * NEO-9 — kits.
 *
 * `quantityPer` is a `decimal` column and reaches the wire as an exact string:
 * a bill of materials that said 0.3333 and came back as a float would build a
 * different number of kits than it was written to build.
 */
const kitComponentSchema = z.object({
  id: z.number().int(),
  componentVariantId: z.number().int(),
  quantityPer: z.string(),
  lineOrder: z.number().int(),
});

export const kitBomResponseSchema = z.array(kitComponentSchema);

/**
 * How many whole kits the components on hand can make. A string, not a number,
 * for the same reason `quantityPer` is one — and `warehouseId` is null when the
 * question was asked across the caller's whole scope rather than at one site.
 */
export const buildableKitsResponseSchema = z.object({
  kitVariantId: z.number().int(),
  warehouseId: z.number().int().nullable(),
  buildable: z.string(),
});

/**
 * `KitAssemblyResult` (`lib/kit-build.ts`). `totalCost` is what the components
 * actually consumed, read back from the engine rather than estimated, which is
 * what lets a disassembly give exactly that figure back.
 */
export const kitAssemblyResponseSchema = z.object({
  kitVariantId: z.number().int(),
  locationId: z.number().int(),
  quantity: z.string(),
  totalCost: z.string(),
  transactionIds: z.array(z.number().int()),
});
