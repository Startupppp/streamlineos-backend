import { z } from "zod";

/**
 * A quantity that becomes a stock movement.
 *
 * Decimal string rather than a number, because `Number(qty).toFixed(4)` is
 * float arithmetic on a ledger row. Positive rather than merely well-formed:
 * moving these fields off `z.number().positive()` and onto a shape regex
 * silently dropped the positivity guard, and `"0"` then passed validation all
 * the way to migration 0515's non-zero CHECK — surfacing as a 500 where the
 * old schema returned a 400.
 */
export const positiveDecimalQuantity = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, "Use a number with up to 4 decimal places")
  .refine((v) => Number(v) > 0, { message: "Quantity must be greater than zero" });

/** Signed, for corrections that go both ways. Still never zero. */
export const nonZeroDecimalQuantity = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, "Use a number with up to 4 decimal places")
  .refine((v) => Number(v) !== 0, { message: "Quantity must not be zero" });
