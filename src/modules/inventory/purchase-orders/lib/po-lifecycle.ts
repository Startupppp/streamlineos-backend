import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { invGrns, invPoLines, invPurchaseOrders } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { StockProjectionService } from "../../stock-engine/stock-projection.service";
import { isPositive, subDec } from "../../stock-engine/decimal";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * What a status transition reads and writes through. The service hands over its
 * own injected collaborators; nothing here constructs anything.
 */
export interface PoLifecycleDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly settingsService: InventorySettingsService;
  readonly warehouseScope: WarehouseScopeService;
  readonly projection: StockProjectionService;
}

/**
 * Load a purchase order and settle whether this caller may move it at all.
 *
 * Every transition below starts here, and out of scope reads as absent: a 403
 * on an id the caller may not see confirms the record exists.
 */
async function loadMovable(deps: PoLifecycleDeps, orgId: string, poId: number, userId: string) {
  const po = await deps.db.query.invPurchaseOrders.findFirst({
    where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
  });
  if (!po) throw new NotFoundException("Purchase order not found");
  await deps.warehouseScope.assertWarehouseVisible(orgId, userId, po.warehouseId);
  return po;
}

/** Both cache doors a transition has to close: the detail row and the list namespace. */
async function invalidate(deps: PoLifecycleDeps, orgId: string, poId: number): Promise<void> {
  await deps.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
}

export async function approvePo(
  deps: PoLifecycleDeps,
  orgId: string,
  poId: number,
  userId: string,
) {
  const settings = await deps.settingsService.get(orgId);
  const po = await loadMovable(deps, orgId, poId, userId);
  if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be approved");

  if (!settings.requirePoApproval) {
    throw new BadRequestException(
      "Purchase order approval is not required for this organisation; send the PO directly",
    );
  }

  const [updated] = await deps.db.update(invPurchaseOrders)
    .set({
      status: "SENT",
      approvedBy: userId,
      approvedAt: new Date(),
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
    .returning();

  await invalidate(deps, orgId, poId);
  return updated;
}

export async function sendPo(deps: PoLifecycleDeps, orgId: string, poId: number, userId: string) {
  const settings = await deps.settingsService.get(orgId);
  const po = await loadMovable(deps, orgId, poId, userId);
  if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be sent");

  if (settings.requirePoApproval && !po.approvedBy) {
    throw new BadRequestException("This purchase order requires approval before sending");
  }

  // A1. `on_order` had no writer at all: it sat at its "0" default while
  // replenishment read it, so a warehouse that had already ordered the
  // shortfall ordered it again the following week. Sending is the moment the
  // goods become expected.
  const [sent] = await deps.db.transaction(async (tx) => {
    // The status predicate belongs in the UPDATE, not only in the read above.
    // Two concurrent sends — a double click, or a client retry after a
    // timeout — both read DRAFT, both passed the guard, and both ran
    // `addOnOrder`, so a 500-unit order booked 1000 as inbound. `addOnOrder`
    // clamps at zero only downward, so the over-booking was unbounded, and
    // replenishment then under-ordered that variant every cycle.
    const updated = await tx
      .update(invPurchaseOrders)
      .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(invPurchaseOrders.id, poId),
        eq(invPurchaseOrders.orgId, orgId),
        eq(invPurchaseOrders.status, "DRAFT"),
      ))
      .returning();

    // Lost the race: another request already sent this order and booked its
    // inbound quantity. Returning what is there is the honest answer to "send
    // this", and it must not book a second time.
    if (updated.length === 0) {
      return deps.db.query.invPurchaseOrders.findFirst({
        where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
      }).then((row) => (row ? [row] : []));
    }

    if (po.warehouseId !== null) {
      const lines = await tx
        .select({
          productVariantId: invPoLines.productVariantId,
          quantity: invPoLines.quantity,
          quantityReceived: invPoLines.quantityReceived,
        })
        .from(invPoLines)
        .where(and(eq(invPoLines.orgId, orgId), eq(invPoLines.poId, poId)));

      for (const line of lines) {
        // Outstanding, not ordered: a partially received order re-sent must
        // not book the already-arrived units as still on their way.
        const outstanding = subDec(
          String(line.quantity),
          String(line.quantityReceived),
        );
        if (isPositive(outstanding)) {
          await deps.projection.addOnOrder(
            tx,
            orgId,
            line.productVariantId,
            po.warehouseId,
            outstanding,
          );
        }
      }
    }
    return updated;
  });

  await invalidate(deps, orgId, poId);
  return sent;
}

/**
 * A1/A2. Take the still-outstanding quantity of a purchase order back out of
 * `on_order`.
 *
 * `sendPo` books the outstanding quantity as expected and a receipt takes the
 * arrived part back out, but the two terminal states did not: a cancelled or
 * closed order left its unreceived remainder booked as inbound forever, and
 * replenishment reading a permanent phantom arrival under-orders that variant
 * every cycle. The reconciliation report names this as `on_order_vs_purchase_orders`
 * drift, which is how it surfaced.
 *
 * Idempotent in effect: `addOnOrder` clamps at zero, and both callers move the
 * order into a terminal status in the same transaction, so it cannot run twice.
 */
async function releaseOnOrder(
  deps: PoLifecycleDeps,
  tx: Tx,
  orgId: string,
  poId: number,
  warehouseId: number | null,
): Promise<void> {
  if (warehouseId === null) return;
  const lines = await tx
    .select({
      productVariantId: invPoLines.productVariantId,
      quantity: invPoLines.quantity,
      quantityReceived: invPoLines.quantityReceived,
    })
    .from(invPoLines)
    .where(and(eq(invPoLines.orgId, orgId), eq(invPoLines.poId, poId)));

  for (const line of lines) {
    const outstanding = subDec(
      String(line.quantity),
      String(line.quantityReceived),
    );
    if (!isPositive(outstanding)) continue;
    await deps.projection.addOnOrder(
      tx,
      orgId,
      line.productVariantId,
      warehouseId,
      `-${outstanding}`,
    );
  }
}

export async function closePo(deps: PoLifecycleDeps, orgId: string, poId: number, userId: string) {
  const po = await loadMovable(deps, orgId, poId, userId);
  if (po.status !== "RECEIVED" && po.status !== "PARTIAL") {
    throw new BadRequestException("Only RECEIVED or PARTIAL purchase orders can be closed");
  }

  const [closed] = await deps.db.transaction(async (tx) => {
    // A PARTIAL order closes with a remainder nobody will ever deliver.
    // Conditional, for the same reason as `sendPo`: two concurrent closes
    // would each release the outstanding quantity, taking it out of `on_order`
    // twice.
    const rows = await tx
      .update(invPurchaseOrders)
      .set({ status: "CLOSED", updatedAt: new Date() })
      .where(and(
        eq(invPurchaseOrders.id, poId),
        eq(invPurchaseOrders.orgId, orgId),
        inArray(invPurchaseOrders.status, ["RECEIVED", "PARTIAL"]),
      ))
      .returning();
    if (rows.length === 0) return rows;
    await releaseOnOrder(deps, tx, orgId, poId, po.warehouseId);
    return rows;
  });

  await invalidate(deps, orgId, poId);
  return closed;
}

export async function cancelPo(deps: PoLifecycleDeps, orgId: string, poId: number, userId: string) {
  const po = await loadMovable(deps, orgId, poId, userId);
  if (po.status !== "DRAFT" && po.status !== "SENT") {
    throw new BadRequestException("Only DRAFT or SENT purchase orders can be cancelled");
  }

  const grnCount = await deps.db.select({ cnt: sql<number>`count(*)::int` })
    .from(invGrns)
    .where(and(eq(invGrns.poId, poId), eq(invGrns.orgId, orgId)));

  if ((grnCount[0]?.cnt ?? 0) > 0) {
    throw new BadRequestException("Cannot cancel a purchase order that has already received goods");
  }

  const [cancelled] = await deps.db.transaction(async (tx) => {
    // Only a SENT order ever booked anything; a DRAFT was never expected.
    const rows = await tx
      .update(invPurchaseOrders)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(
        eq(invPurchaseOrders.id, poId),
        eq(invPurchaseOrders.orgId, orgId),
        inArray(invPurchaseOrders.status, ["DRAFT", "SENT"]),
      ))
      .returning();
    if (rows.length === 0) return rows;
    // Only a SENT order ever booked anything; a DRAFT was never expected.
    if (po.status === "SENT")
      await releaseOnOrder(deps, tx, orgId, poId, po.warehouseId);
    return rows;
  });

  await invalidate(deps, orgId, poId);
  return cancelled;
}
