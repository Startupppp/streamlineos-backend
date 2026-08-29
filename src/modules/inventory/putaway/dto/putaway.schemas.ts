import { z } from "zod";
import { positiveDecimalQuantity } from "../../stock-engine/dto/quantity.schemas";

/**
 * B3, item 1. Raise the walk for a receipt that has already posted.
 *
 * The receipt is the only input, and everything else is read from what it
 * actually landed: the receiving location, the grains and the quantities come
 * from the ledger rows the post wrote, not from a body. A client that could name
 * the quantity could raise a putaway for stock that never arrived.
 */
export const createPutawayTaskSchema = z
  .object({
    grnId: z.number().int().positive(),
  })
  .strict();
export type CreatePutawayTaskInput = z.infer<typeof createPutawayTaskSchema>;

/**
 * The workbench's own query — tasks waiting, and tasks this operator holds.
 *
 * `assignment` is a view rather than a user id, for the same reason picking's
 * is: a client that could name the operator could read somebody else's queue,
 * and "whose tasks am I looking at" is answered from the token.
 */
export const listPutawayTasksSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
    warehouseId: z.coerce.number().int().positive().optional(),
    assignment: z.enum(["ANY", "MINE", "UNCLAIMED"]).default("ANY"),
  })
  .strict();
export type ListPutawayTasksInput = z.infer<typeof listPutawayTasksSchema>;

/**
 * B3, item 1. What was actually walked.
 *
 * The quantity is a decimal string, never a number: `Number(qty).toFixed(4)` is
 * float arithmetic on a `numeric(18,4)` and item 4 forbids it outright. Less
 * than the line asks for is a partial putaway and a legitimate state — an
 * operator who filled the bin and carried the rest back has not failed.
 *
 * `toLocationId` is the bin the operator confirmed. Optional because the line
 * already carries a suggestion, and refused outright on a QUARANTINE line:
 * where the goods go is decided by their quality state, not at the shelf.
 */
export const completePutawaySchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            taskLineId: z.number().int().positive(),
            quantity: positiveDecimalQuantity,
            toLocationId: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type CompletePutawayInput = z.infer<typeof completePutawaySchema>;
