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
    /**
     * The window the wave was raised in, filtering `created_at`. Optional and
     * independent, so either edge alone is a valid open-ended window.
     *
     * Days rather than instants, and inclusive of `to`: this exists so a
     * dashboard drilling through from a report can carry the date window the
     * reader is looking at, and a window that silently dropped the last day
     * would disagree with the report it came from.
     */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
 * INV-205 / B5. Why a line could not close as asked.
 *
 * Three shapes rather than one, because the reasons carry different evidence
 * and the schema is where an impossible combination stops being constructible:
 *
 *   * the plain shortfalls carry only a note -- "the shelf was empty" has no
 *     second item and no second place to record;
 *   * `WRONG_LOCATION` carries where the goods actually were, which is the
 *     whole content of the report and the thing that lets the line be
 *     retargeted rather than written off;
 *   * `SUBSTITUTED` carries what went in the tote instead, and reaches the API
 *     through its own route because swapping a SKU rewrites what the customer
 *     is owed and answers to its own permission.
 */
const plainExceptionShape = {
  pickLineId: z.number().int().positive(),
  notes: z.string().max(500).optional(),
};

const shortfallException = z
  .object({
    ...plainExceptionShape,
    reason: z.enum(["SHORT", "NOT_FOUND", "DAMAGED"]),
  })
  .strict();

const wrongLocationException = z
  .object({
    ...plainExceptionShape,
    reason: z.literal("WRONG_LOCATION"),
    /**
     * Where the picker actually found them. Optional: a picker who knows only
     * that the bin was wrong still has something worth reporting, and demanding
     * a location they cannot supply would push them onto `NOT_FOUND`, which
     * means something else entirely.
     */
    foundLocationId: z.number().int().positive().optional(),
  })
  .strict();

export const reportPickExceptionSchema = z.discriminatedUnion("reason", [
  shortfallException,
  wrongLocationException,
  z
    .object({
      ...plainExceptionShape,
      reason: z.literal("SUBSTITUTED"),
      substituteVariantId: z.number().int().positive(),
      quantityPicked: positiveDecimalQuantity,
    })
    .strict(),
]);
export type ReportPickExceptionInput = z.infer<typeof reportPickExceptionSchema>;

/**
 * B5. What the ordinary exception route accepts.
 *
 * `SUBSTITUTED` is absent deliberately. `PermissionGuard` reads exactly one
 * `@RequirePermission` per handler, so a single endpoint covering every reason
 * could only be gated at the weakest of them -- and a picker allowed to say
 * "the shelf was empty" would thereby be allowed to change what the customer is
 * owed. Splitting the route is how the two authorities stay apart.
 */
export const reportPlainPickExceptionSchema = z.discriminatedUnion("reason", [
  shortfallException,
  wrongLocationException,
]);
export type ReportPlainPickExceptionInput = z.infer<typeof reportPlainPickExceptionSchema>;

/** B5. The substitution route's body -- the reason is the route, so it is implied. */
export const substitutePickLineSchema = z
  .object({
    pickLineId: z.number().int().positive(),
    substituteVariantId: z.number().int().positive(),
    quantityPicked: positiveDecimalQuantity,
    notes: z.string().max(500).optional(),
  })
  .strict();
export type SubstitutePickLineInput = z.infer<typeof substitutePickLineSchema>;

/**
 * B5. The supervisor queue.
 *
 * `ownership` is a view rather than a user id, for the same reason `assignment`
 * is on the wave queue: a query that could name the owner could read somebody
 * else's queue, and "whose exceptions am I looking at" is answered from the
 * token.
 */
export const listPickExceptionsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(["OPEN", "RESOLVED"]).optional(),
    reason: z
      .enum(["SHORT", "NOT_FOUND", "DAMAGED", "SUBSTITUTED", "WRONG_LOCATION"])
      .optional(),
    warehouseId: z.coerce.number().int().positive().optional(),
    ownership: z.enum(["ANY", "MINE"]).default("ANY"),
  })
  .strict();
export type ListPickExceptionsInput = z.infer<typeof listPickExceptionsSchema>;

/**
 * B5. What a reviewer decided.
 *
 * The note is required rather than optional: the value of a review is that
 * somebody can later read why the order shipped the way it did, and a bare
 * `ACCEPTED` with no words answers nothing.
 */
export const resolvePickExceptionSchema = z
  .object({
    resolution: z.enum(["ACCEPTED", "REJECTED"]),
    notes: z.string().min(1).max(500),
  })
  .strict();
export type ResolvePickExceptionInput = z.infer<typeof resolvePickExceptionSchema>;

/** B5. Handing an exception to the person who will actually deal with it. */
export const assignPickExceptionSchema = z
  .object({
    ownerUserId: z.string().min(1).max(255),
  })
  .strict();
export type AssignPickExceptionInput = z.infer<typeof assignPickExceptionSchema>;
