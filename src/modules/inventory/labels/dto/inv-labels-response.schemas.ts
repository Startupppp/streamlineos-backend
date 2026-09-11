import { z } from "zod";

/**
 * G4 — `LabelPayload` (`barcode/dto/inv-barcode.schemas.ts`).
 *
 * JSON rather than a rendered label, because the symbology and the label stock
 * are decisions made at the printer. `codeSource` says which column `code` came
 * off so the printer can choose one, and `gs1` is offered alongside rather than
 * instead — it exists only where the variant carries a real GTIN.
 */
export const variantLabelResponseSchema = z.object({
  productVariantId: z.number().int(),
  productId: z.number().int(),
  productName: z.string(),
  variantName: z.string(),
  sku: z.string(),
  code: z.string(),
  codeSource: z.enum(["barcode", "sku"]),
  uom: z.string().nullable(),
  lot: z.object({
    lotId: z.number().int(),
    lotNumber: z.string(),
    expiryDate: z.string().nullable(),
    manufactureDate: z.string().nullable(),
  }).nullable(),
  gs1: z.string().nullable(),
  qrDataUri: z.string(),
  printedAt: z.string(),
  organizationName: z.string(),
});
