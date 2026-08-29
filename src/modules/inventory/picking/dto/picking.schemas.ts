import { positiveDecimalQuantity } from "../../stock-engine/dto/quantity.schemas";
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

/**
 * B4, item 5. The workbench's own query — the waves waiting for a picker and
 * the ones this picker is already walking.
 *
 * `assignment` is a view rather than a user id: a client that could name the
 * picker could name somebody else's queue, and "whose waves am I looking at" is
 * answered from the token, never from the body.
 */
export const listWavesSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
    warehouseId: z.coerce.number().int().positive().optional(),
    assignment: z.enum(["ANY", "MINE", "UNCLAIMED"]).default("ANY"),
  })
  .strict();
export type ListWavesInput = z.infer<typeof listWavesSchema>;

/**
 * B4, item 3. Handing a wave to somebody else.
 *
 * The only picking body that names a person, and it names the *other* person —
 * claiming and abandoning both derive the actor from the token, because a body
 * that could say who claimed a wave could claim one on somebody else's behalf.
 */
export const reassignWaveSchema = z
  .object({
    assigneeUserId: z.string().min(1).max(255),
  })
  .strict();
export type ReassignWaveInput = z.infer<typeof reassignWaveSchema>;

export const confirmPickSchema = z
  .object({
    pickLineId: z.number().int().positive(),
    quantityPicked: positiveDecimalQuantity,
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
        quantityPicked: positiveDecimalQuantity,
        notes: z.string().max(500).optional(),
      })
      .strict(),
  ]);
export type ReportPickExceptionInput = z.infer<typeof reportPickExceptionSchema>;
