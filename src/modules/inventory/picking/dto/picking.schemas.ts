import { z } from "zod";

/** INV-204. One walk across several orders. */
export const createWaveSchema = z
  .object({
    warehouseId: z.number().int().positive(),
    // Capped: a wave is a walk somebody has to finish, and an unbounded one is
    // a pick list nobody completes.
    soIds: z.array(z.number().int().positive()).min(1).max(50),
  })
  .strict();
export type CreateWaveInput = z.infer<typeof createWaveSchema>;

export const confirmPickSchema = z
  .object({
    pickLineId: z.number().int().positive(),
    quantityPicked: z.string().regex(/^\d+(\.\d{1,4})?$/),
    locationId: z.number().int().positive().optional(),
    /**
     * What the scanner read, if the picker scanned. The server compares it to
     * the line rather than trusting the device to have done so: the screen is
     * showing the task, so it agrees with itself whatever is in the picker's
     * hand.
     */
    scannedPayload: z.string().min(1).max(500).optional(),
  })
  .strict();
export type ConfirmPickInput = z.infer<typeof confirmPickSchema>;

/**
 * INV-205. Why a line could not close as asked.
 *
 * A substitution has to name what went in the tote instead; the others do not,
 * because "the shelf was empty" has no second item to record. Enforced by the
 * schema rather than the service, so the impossible combination cannot be
 * constructed.
 */
export const reportPickExceptionSchema = z
  .discriminatedUnion("reason", [
    z
      .object({
        pickLineId: z.number().int().positive(),
        reason: z.enum(["SHORT", "NOT_FOUND", "DAMAGED"]),
        notes: z.string().max(500).optional(),
      })
      .strict(),
    z
      .object({
        pickLineId: z.number().int().positive(),
        reason: z.literal("SUBSTITUTED"),
        substituteVariantId: z.number().int().positive(),
        quantityPicked: z.string().regex(/^\d+(\.\d{1,4})?$/),
        notes: z.string().max(500).optional(),
      })
      .strict(),
  ]);
export type ReportPickExceptionInput = z.infer<typeof reportPickExceptionSchema>;
