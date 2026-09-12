import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invCustomerReturns,
  invCustomerReturnLines,
  invLocations,
  invSerialNumbers,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { StockEngineService } from "../../stock-engine/stock-engine.service";
import { StockMovementBridgeService } from "../../../accounting/adapters/stock-movement-bridge.service";
import type { StockMovement } from "../../stock-engine/stock-engine.types";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../../stock-engine/command-events";
import { assertCustomerReturnWithinShipped } from "../returnable-quantity";
import type { PostCustomerReturnInput } from "../dto/inv-returns.schemas";
import {
  movementsForDisposition,
  serialStatusForDisposition,
  type ReturnSerialStatus,
} from "../return-dispositions";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReturnLineRow = typeof invCustomerReturnLines.$inferSelect;

/**
 * Posting a customer return: the stock half, inside the caller's transaction.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape — the DI graph and every caller stay unchanged, and the
 * transaction stays owned by whoever opened it.
 */
export interface ReturnPostDeps {
  readonly engine: StockEngineService;
  /** ACC-21. The restock posts to the general ledger on the return's own transaction. */
  readonly glBridge: StockMovementBridgeService;
}

export /**
 * INV-209. Posting moves stock, so every line must have been *looked at* first
 * — `inspectedAt`, not merely `disposition`.
 *
 * Gating on the disposition was the weaker test and it defeated the ticket: a
 * disposition declared at intake is a guess from the customer's description,
 * which is exactly the thing that was posting stock without anybody opening the
 * box. It is still accepted at create as a statement of intent; it just no
 * longer counts as an inspection.
 *
 * Reported together rather than one at a time: somebody clearing a twelve-line
 * return should not discover the gaps twelve attempts later.
 */
function assertEveryLineInspected(lines: ReturnLineRow[]): void {
  const uninspected = lines.filter((line) => line.inspectedAt === null);
  if (uninspected.length > 0) {
    throw new BadRequestException(
      `These lines have not been inspected yet: ${uninspected.map((l) => l.id).join(", ")}`,
    );
  }
}

export async function postReturnInTx(
  deps: ReturnPostDeps,
  tx: Tx,
  orgId: string,
  returnId: number,
  userId: string,
  idempotencyKey: string,
  data: PostCustomerReturnInput,
): Promise<number> {
  // The row lock before anything is read. Two posts under different keys
  // otherwise both see APPROVED and both move stock.
  const [locked] = await tx.execute<{ status: string }>(sql`
    SELECT status FROM inv_customer_returns
    WHERE id = ${returnId} AND org_id = ${orgId} FOR UPDATE`);
  if (!locked) throw new NotFoundException("Customer return not found");
  // Already posted under some other key. The ledger is append-only and the
  // goods are already on the shelf, so the only correct answer is to change
  // nothing.
  if (locked.status === "POSTED") return returnId;
  if (locked.status !== "APPROVED") {
    throw new BadRequestException(
      locked.status === "DRAFT"
        ? "This customer return must be approved before it can be posted"
        : `A ${locked.status} customer return cannot be posted`,
    );
  }

  const ret = await tx.query.invCustomerReturns.findFirst({
    where: and(eq(invCustomerReturns.id, returnId), eq(invCustomerReturns.orgId, orgId)),
    with: { lines: true },
  });
  if (!ret) throw new NotFoundException("Customer return not found");

  // INV-209. Re-asserted under the lock rather than trusted from the
  // approval: posting is what moves stock, so posting is what has to be sure.
  assertEveryLineInspected(ret.lines);
  await assertReturnableInTx(tx, orgId, ret, ret.lines);

  const engineMovements: StockMovement[] = [];
  for (const line of ret.lines) {
    const targetLocationId = await resolveTargetLocation(deps, tx, orgId, line);
    engineMovements.push(...movementsForDisposition(
      {
        productVariantId: line.productVariantId,
        disposition: line.disposition,
        quantity: line.quantity,
        lotId: line.lotId,
        serialId: line.serialId,
      },
      targetLocationId,
    ));
  }

  const byStatus = new Map<ReturnSerialStatus, number[]>();
  for (const line of ret.lines) {
    if (line.serialId === null) continue;
    const serialStatus = serialStatusForDisposition(line.disposition);
    const ids = byStatus.get(serialStatus) ?? [];
    ids.push(line.serialId);
    byStatus.set(serialStatus, ids);
  }

  if (engineMovements.length > 0) {
    const moved = await deps.engine.executeInTx(tx, orgId, userId, {
      // Derived rather than shared: the command's own key is already claimed
      // by `runIdempotent` above, and handing the engine the same string
      // would make it collide with that live claim.
      idempotencyKey: `${idempotencyKey}:stock`,
      sourceType: "inv_customer_return",
      sourceId: String(returnId),
      reason: data.reason,
      movements: engineMovements,
    });

    /*
      ACC-21. Goods coming back into stock reverse the cost of the sale that
      shipped them, so the counterpart is COGS rather than an adjustment —
      that is what puts the margin back in the period the return lands in. A
      line quarantined instead of restocked posts nothing, because the
      business owned those goods either way; the bridge reads each movement's
      type and value off the rows just written and decides that itself.
    */
    await deps.glBridge.post(
      orgId,
      userId,
      {
        kind: "customer_return",
        documentId: String(returnId),
        transactionIds: moved.transactionIds,
        journalDate: new Date().toISOString().slice(0, 10),
        memo: `Customer return ${ret.returnNumber}`,
      },
      tx,
    );
  }

  for (const [serialStatus, ids] of byStatus) {
    await tx.update(invSerialNumbers)
      .set({ status: serialStatus })
      .where(inArray(invSerialNumbers.id, ids));
  }

  await tx.update(invCustomerReturns)
    .set({ status: "POSTED", postedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(invCustomerReturns.id, returnId),
      eq(invCustomerReturns.orgId, orgId),
      eq(invCustomerReturns.status, "APPROVED"),
    ));

  await emitInventoryCommandEvent(tx, {
    orgId,
    eventType: INVENTORY_COMMAND_EVENTS.RETURN_POSTED,
    aggregateType: "inv_customer_return",
    aggregateId: String(returnId),
    actorUserId: userId,
    payload: {
      // One event type for both directions, because "goods came back" is
      // one thing a consumer subscribes to; which way they went is a
      // field, not a separate contract.
      returnType: "CUSTOMER",
      returnId,
      returnNumber: ret.returnNumber,
      soId: ret.soId,
      shipmentId: ret.shipmentId,
      clientId: ret.clientId,
      lineCount: ret.lines.length,
      // What was decided about the goods. A restock and a scrap are the
      // same document and opposite outcomes, and a consumer that has to
      // re-read the lines to tell them apart has been told nothing.
      dispositions: ret.lines.map((line) => ({
        lineId: line.id,
        productVariantId: line.productVariantId,
        disposition: line.disposition,
      })),
      // Item 5. The pointer, carried so an accounting adapter can reconcile
      // the credit against the goods without asking us for it.
      creditReference: ret.creditReference,
      approvedBy: ret.approvedBy,
      reason: data.reason ?? null,
      idempotencyKey,
    },
  });

  return returnId;
}

export function assertReturnableInTx(
  tx: Tx,
  orgId: string,
  ret: { id: number; soId: number | null; shipmentId: number | null },
  lines: ReturnLineRow[],
): Promise<void> {
  return assertCustomerReturnWithinShipped(
    tx,
    orgId,
    ret.id,
    { soId: ret.soId, shipmentId: ret.shipmentId },
    lines,
  );
}

/**
 * Where these goods land.
 *
 * The line's own choice wins. Failing that the disposition decides the kind of
 * place: quarantined goods want a QUARANTINE bin, everything kept wants a
 * RETURNS bin. The final fallback excludes locations flagged unsellable —
 * every warehouse has a `TRANSIT` location and it is `is_sellable = false`, so
 * restocking into one would raise on-hand while availability stayed flat and
 * the goods would read as lost.
 */
async function resolveTargetLocation(
  deps: ReturnPostDeps,
  tx: Tx,
  orgId: string,
  line: Pick<ReturnLineRow, "disposition" | "targetLocationId">,
): Promise<number> {
  if (line.targetLocationId) return line.targetLocationId;

  type LocationType = typeof invLocations.$inferSelect["locationType"];
  const locationType: LocationType = line.disposition === "QUARANTINE" ? "QUARANTINE" : "RETURNS";
  const loc = await tx.query.invLocations.findFirst({
    where: and(
      eq(invLocations.orgId, orgId),
      eq(invLocations.locationType, locationType),
      eq(invLocations.isActive, true),
    ),
    columns: { id: true },
  });

  if (loc) return loc.id;

  const [anyLoc] = await tx.execute<{ id: number }>(sql`
    SELECT id FROM inv_locations
    WHERE org_id = ${orgId} AND is_active = true AND is_sellable IS NOT FALSE
    ORDER BY id ASC LIMIT 1`);

  if (!anyLoc) throw new BadRequestException("No active location found for customer return");
  return Number(anyLoc.id);
}
