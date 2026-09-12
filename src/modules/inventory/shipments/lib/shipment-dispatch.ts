import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  invShipments,

  invPackages,
  invSalesOrders,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { runIdempotent } from "../../stock-engine/idempotency";
import { shipmentInScope } from "./shipment-scope";
import type { ShipActionInput } from "../dto/shipments.schemas";

/**
 * Dispatching a shipment — the one command in this service that moves stock.
 *
 * Split from the document surface next door because the two are gated
 * differently and it matters where. List, create, update and cancel each gate
 * their own read; this one gates the ENTRY read specifically, so an
 * out-of-scope dispatch never reaches the idempotency claim and cannot burn a
 * key. The re-read at the tail runs inside the transaction that gate already
 * covered.
 */
export interface ShipDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: InventoryAuditService;
  readonly settings: InventorySettingsService;
  readonly warehouseScope: WarehouseScopeService;
}

export async function shipShipment(
  deps: ShipDeps,
  orgId: string,
  userId: string,
  shipmentId: number,
  input: ShipActionInput,
  idempotencyKey: string,
) {
  // The gate sits on the entry read, so an out-of-scope dispatch never reaches
  // the claim and cannot burn an idempotency key either. The re-read at the
  // tail runs inside the transaction this has already been gated for.
  const scope = await deps.warehouseScope.forUser(orgId, userId);
  const [shipment] = await deps.db.select().from(invShipments).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId), shipmentInScope(scope))).limit(1);
  if (!shipment) throw new NotFoundException("Shipment not found");

  if (shipment.status === "SHIPPED") return shipment;
  if (shipment.status === "CANCELLED") throw new ConflictException("Shipment is cancelled");

  if (shipment.soId != null) {
    const [so] = await deps.db.select().from(invSalesOrders).where(and(eq(invSalesOrders.id, shipment.soId), eq(invSalesOrders.orgId, orgId))).limit(1);
    if (so && so.status !== "SHIPPED") {
      throw new ConflictException("Ship via sales order first");
    }
  }

  const cfg = await deps.settings.get(orgId);
  if (cfg.packageRequiredForShipping) {
    const [pkgCount] = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invPackages)
      .where(and(eq(invPackages.shipmentId, shipmentId), eq(invPackages.orgId, orgId), eq(invPackages.status, "CLOSED")));
    if ((pkgCount?.count ?? 0) === 0) {
      throw new BadRequestException("At least one closed package required");
    }
  }

  const safeInput = input ?? {};
  // A3. The key used to reach this method and stop here, recorded as audit
  // metadata and never claimed. The status read above is not a substitute: it
  // happens outside the write, so two copies of the same request in flight
  // together both see PACKED, both flip the row and both emit
  // `inventory.shipment.dispatched` -- two dispatches to the carrier for one
  // shipment. The claim and the dispatch share this transaction, so the event
  // is emitted exactly as often as the key is claimed.
  const updated = await deps.db.transaction(async (tx) => {
    await runIdempotent(
      tx,
      orgId,
      idempotencyKey,
      {
        shipmentId,
        trackingNumber: safeInput.trackingNumber ?? null,
        carrierId: safeInput.carrierId ?? null,
      },
      async () => {
        const rows = await tx.update(invShipments).set({
          status: "SHIPPED",
          shippedAt: new Date(),
          trackingNumber: safeInput.trackingNumber ?? shipment.trackingNumber,
          carrierId: safeInput.carrierId ?? shipment.carrierId,
          updatedAt: new Date(),
        }).where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).returning();
        await deps.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "shipment.shipped",
          resourceType: "shipment",
          resourceId: String(shipmentId),
          metadata: { idempotencyKey },
        });
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "inv_shipment",
          aggregateId: String(shipmentId),
          aggregateVersion: Date.now(),
          eventType: "inventory.shipment.dispatched",
          payload: {
            shipmentId,
            shipmentNumber: rows[0]?.shipmentNumber ?? shipment.shipmentNumber,
            soId: shipment.soId,
            // A5. Purely additive. The sales-order fulfilment path now emits
            // this same event for the shipments it raises, so a consumer that
            // cares which command shipped can tell without inferring it from
            // the absence of a field.
            shippedVia: "shipment.ship",
            actorUserId: userId,
          },
          occurredAt: new Date(),
        });
        return { shipmentId };
      },
      // The row is re-read below on both paths rather than revived from the
      // stored JSON, so a replay answers with the shipment as it now stands
      // and no `Date` has to survive a round trip through jsonb.
      () => ({ shipmentId }),
    );
    const [row] = await tx.select().from(invShipments)
      .where(and(eq(invShipments.id, shipmentId), eq(invShipments.orgId, orgId))).limit(1);
    return row;
  });
  await deps.cache.invalidateNamespace(CACHE_KEYS.invShipmentsNamespace(orgId));
  return updated;
}
