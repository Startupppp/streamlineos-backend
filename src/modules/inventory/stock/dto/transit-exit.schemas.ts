import { z } from "zod";
import { positiveDecimalQuantity } from "../../stock-engine/dto/quantity.schemas";

/**
 * R3, item 2 — the way out of transit.
 *
 * A dispatched transfer parks its goods at the source warehouse's `TRANSIT`
 * location and a short receipt takes only what arrived off it. Everything else
 * stays there: on hand, unsellable, and with no command anywhere that could move
 * it. This is that command's boundary.
 */

/**
 * What is being done with the stranded units, and it is never "nothing".
 *
 * `RETURN_TO_SOURCE` says the goods came back off the van and belong on the
 * shelf they left; `WRITE_OFF` says they are not coming back and the loss is
 * real. Both post movements. Neither is a delete, and there is deliberately no
 * third value meaning "clear the row" — that is what the defect looked like.
 */
export const TRANSIT_EXIT_DISPOSITIONS = ["RETURN_TO_SOURCE", "WRITE_OFF"] as const;
export type TransitExitDisposition = (typeof TRANSIT_EXIT_DISPOSITIONS)[number];

/**
 * One transfer line's share of the exit.
 *
 * Keyed on the transfer line rather than on (variant, lot, serial): the transit
 * location is per **warehouse**, so several transfers' goods stand on the same
 * bin and a grain alone cannot say whose units are being moved. The line is the
 * document, and the document is what makes this auditable.
 */
const transitExitLineSchema = z
  .object({
    transferLineId: z.number().int().positive(),
    /**
     * Optional: absent means the whole stranded remainder of that line, which is
     * the common case and the one a client should not have to compute. A partial
     * exit is legitimate — half a pallet found, half written off — so a quantity
     * is accepted, bounded server-side by what the line actually stranded.
     */
    quantity: positiveDecimalQuantity.optional(),
  })
  .strict();

export const transitExitSchema = z
  .object({
    transferId: z.number().int().positive(),
    disposition: z.enum(TRANSIT_EXIT_DISPOSITIONS),
    /**
     * Required, and not an enum. "Abandon" without a sentence is the silent
     * delete under another name: the value of this command is that somebody can
     * later read why 25 units left the books, and a fixed reason list would
     * force every real answer into `OTHER`.
     */
    reason: z.string().min(1).max(500),
    /**
     * Absent means every line with a stranded remainder. A transfer abandoned
     * wholesale is one call, not one per line.
     */
    lines: z.array(transitExitLineSchema).min(1).max(200).optional(),
  })
  .strict();
export type TransitExitInput = z.infer<typeof transitExitSchema>;

/**
 * The queue the command acts on.
 *
 * `view` rather than a free `status` filter: the two questions a warehouse
 * actually asks are "what is on a van right now" and "what did a short receipt
 * leave behind", and the second is the one that needs a decision. Naming them
 * keeps the client out of the business of knowing that `COMPLETED` plus an
 * unreceived remainder means stranded.
 */
export const listStrandedTransitSchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    view: z.enum(["ANY", "STRANDED"]).default("ANY"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type ListStrandedTransitInput = z.infer<typeof listStrandedTransitSchema>;
