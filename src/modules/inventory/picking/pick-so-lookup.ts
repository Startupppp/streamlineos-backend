import { and, eq } from "drizzle-orm";
import { invSoLines } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * D2 — which sales order a pick line serves.
 *
 * A pick line carries `soLineId`, not `soId`, and the customer's contracted
 * shelf-life floor hangs off the order rather than the line. One projected read
 * rather than joining it into every caller's query: the lookup happens once per
 * confirm, and threading a second column through four call sites to save it
 * would be the wrong trade.
 *
 * Returns null when the line serves no order — a wave line can exist without
 * one — and null is the honest answer rather than a default floor: with no
 * destination there is no supply agreement, and inventing one would refuse
 * stock nobody has objected to.
 */
export async function soIdForLine(
  tx: Tx,
  orgId: string,
  soLineId: number,
): Promise<number | null> {
  const [row] = await tx
    .select({ soId: invSoLines.soId })
    .from(invSoLines)
    .where(and(eq(invSoLines.orgId, orgId), eq(invSoLines.id, soLineId)))
    .limit(1);
  return row?.soId ?? null;
}
