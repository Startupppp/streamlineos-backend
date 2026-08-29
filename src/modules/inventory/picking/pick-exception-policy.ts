import { sql, type SQL } from "drizzle-orm";
import type { ReportPickExceptionInput } from "./dto/picking.schemas";

/** Every reason a pick line can carry, as the enum spells them. */
export type PickExceptionReason = ReportPickExceptionInput["reason"];

/**
 * B5, item 4 — the two an exception cannot settle on its own.
 *
 * A damaged unit is a write-off somebody has to accept, and a substitution
 * changes what the customer receives. Both are decisions above a picker's pay
 * grade taken at a shelf, so the report stands as a fact and a reviewer signs
 * it. The other three describe a shortfall the warehouse can see for itself in
 * the numbers, and holding a wave open for a countersignature on "the bin was
 * empty" would teach every supervisor to rubber-stamp the queue.
 */
export const REVIEW_REQUIRED_REASONS = ["DAMAGED", "SUBSTITUTED"] as const;

export function requiresReview(reason: PickExceptionReason): boolean {
  return (REVIEW_REQUIRED_REASONS as readonly string[]).includes(reason);
}

/**
 * B5 — `WRONG_LOCATION` is the one reason that does not close its line.
 *
 * The other four all say the units are not coming: the shelf was short, the bin
 * was empty, the goods were broken, or something else went in the tote. This one
 * says the goods exist and the wave sent the picker to the wrong place, which is
 * a correction rather than a write-off — so the line is retargeted to where they
 * actually were and the work stays outstanding. Treating it as closing would
 * turn "I found them one aisle over" into an order that ships short.
 */
export function closesLine(reason: PickExceptionReason): boolean {
  return reason !== "WRONG_LOCATION";
}

/**
 * Whether a pick line is finished with, as one expression.
 *
 * Three readers need this rule — `waveIsComplete`, the wave queue's
 * `lines_closed` aggregate, and the supervisor queue's blocking count — and
 * three hand-written copies is how the board comes to say 4/4 while the wave
 * refuses to complete. It is SQL rather than TypeScript because two of the three
 * are aggregates over rows the server never loads, and because the quantity
 * comparison belongs in `numeric`: deciding a line is done on the strength of a
 * float comparison is how an order ships one unit short and nothing notices.
 *
 * Written against `inv_pick_list_lines` aliased `pll`, which every caller uses.
 *
 * The three clauses, in the order they matter:
 *
 *   1. picked in full — the ordinary way a line ends;
 *   2. `WRONG_LOCATION` never closes it (see `closesLine`);
 *   3. a reason that needs a reviewer closes it only once one has been. This is
 *      B5's "unresolved can block wave complete where required" — the block is
 *      the absence of a close, not a separate flag, so there is no second thing
 *      to keep in step.
 */
export const PICK_LINE_CLOSED_SQL: SQL = sql`(
  pll.quantity_picked::numeric >= pll.quantity_to_pick::numeric
  OR (
    pll.exception_reason IS NOT NULL
    AND pll.exception_reason <> 'WRONG_LOCATION'
    AND (
      pll.exception_reason NOT IN ('DAMAGED', 'SUBSTITUTED')
      OR pll.exception_status = 'RESOLVED'
    )
  )
)`;
