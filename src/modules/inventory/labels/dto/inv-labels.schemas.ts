import { z } from "zod";

/**
 * G4 — a label is printed for a SKU, and optionally for one batch of it.
 *
 * `lotId` rather than a lot number: a number is not unique across variants, and
 * accepting one would let a caller print this SKU's label over another product's
 * batch. The id is checked against the variant before anything is rendered.
 */
export const variantLabelQuerySchema = z
  .object({
    lotId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export type VariantLabelQueryInput = z.infer<typeof variantLabelQuerySchema>;
