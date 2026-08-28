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
