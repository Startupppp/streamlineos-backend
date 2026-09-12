import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  invCustomerReturns,
  invCustomerReturnLines,
  invSalesOrders,
  invShipments,
} from "../../../../db/schema";
import { clientPartyMap } from "../../../../db/schema/party";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { assertCustomerReturnWithinShipped } from "../returnable-quantity";
import type { CreateCustomerReturnInput } from "../dto/inv-returns.schemas";

/**
 * Opening a customer return, and proving the caller may open it against that
 * source document.
 *
 * `reloadUnscopedReturn` is a CALLBACK rather than an imported read.
 * `loadCustomerReturnUnscoped` is the read that skips `returnInScope`, and
 * `customer-return-detail-scope.spec.ts` pins it as a named PRIVATE method so a
 * future route cannot be pointed at it by accident. Exporting it from `lib/`
 * would undo that; handing this flow a bound closure keeps it on the service,
 * which is the only place that has already settled the caller's standing.
 */
export interface ReturnCreateDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly numSeq: NumberSequenceService;
  readonly warehouseScope: WarehouseScopeService;
  readonly reloadUnscopedReturn: (orgId: string, returnId: number) => Promise<unknown>;
}

export async function createCustomerReturn(
  deps: ReturnCreateDeps,
  orgId: string,
  userId: string,
  data: CreateCustomerReturnInput,
) {
  if (data.soId !== undefined && data.soId !== null) {
    const so = await deps.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, data.soId), eq(invSalesOrders.orgId, orgId)),
      columns: { id: true },
    });
    if (!so) throw new BadRequestException("Sales order not found in this organization");
  }

  if (data.shipmentId !== undefined && data.shipmentId !== null) {
    const shipment = await deps.db.query.invShipments.findFirst({
      where: and(eq(invShipments.id, data.shipmentId), eq(invShipments.orgId, orgId)),
      columns: { id: true },
    });
    if (!shipment) throw new BadRequestException("Shipment not found in this organization");
  }

  // The two checks above answer "is this id mine to name at all"; neither ever
  // asked whose building the document came out of. This does.
  await assertSourceInScope(deps, orgId, userId, data);

  if (data.clientId !== undefined && data.clientId !== null) {
    /*
     * Asked of `client_party_map` rather than `clients`, which answers the same
     * question through the Party seam. The map's primary key is
     * `(organization_id, client_id)` and its composite foreign key cascades from
     * `clients`, so a row exists here exactly when the client exists in this
     * tenant -- which is all this check ever wanted. `invCustomerReturns.client_id`
     * still points at `clients`, so the id kept here is still the legacy one.
     */
    const [client] = await deps.db
      .select({ id: clientPartyMap.clientId })
      .from(clientPartyMap)
      .where(
        and(
          eq(clientPartyMap.clientId, data.clientId),
          eq(clientPartyMap.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!client) throw new BadRequestException("Client not found in this organization");
  }

  // B9, item 3. Refused at intake as well as at approval, so somebody typing
  // 12 against a shipment of 10 finds out now rather than after an inspection
  // walk. Return id 0 excludes nothing, which is right: this return does not
  // exist yet.
  await assertCustomerReturnWithinShipped(
    deps.db,
    orgId,
    0,
    { soId: data.soId ?? null, shipmentId: data.shipmentId ?? null },
    data.lines.map((line) => ({
      productVariantId: line.productVariantId,
      lotId: line.lotId ?? null,
      serialId: line.serialId ?? null,
      quantity: line.quantity,
    })),
  );

  const returnNumber = await deps.numSeq.next(orgId, "CUSTOMER_RETURN");

  const [ret] = await deps.db.insert(invCustomerReturns).values({
    orgId,
    returnNumber,
    soId: data.soId,
    shipmentId: data.shipmentId,
    clientId: data.clientId,
    notes: data.notes,
    status: "DRAFT",
    createdBy: userId,
  }).returning();

  await deps.db.insert(invCustomerReturnLines).values(
    data.lines.map((line) => ({
      orgId,
      returnId: ret.id,
      productVariantId: line.productVariantId,
      lotId: line.lotId,
      serialId: line.serialId,
      quantity: line.quantity,
      disposition: line.disposition,
      targetLocationId: line.targetLocationId,
      notes: line.reason,
    }))
  );

  await deps.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId));
  return deps.reloadUnscopedReturn(orgId, ret.id);
}

/**
 * You may raise a return only against a document out of a warehouse you hold.
 *
 * `create` validated `so_id` and `shipment_id` against the ORG and stopped
 * there, so a scoped operator could anchor a DRAFT to another warehouse's
 * order or shipment. Nothing moved — a DRAFT posts no stock — and every step
 * after it is gated, so the document became invisible to the person who
 * raised it the moment they saved it: a write into a building they hold
 * nothing in, leaving an orphaned draft behind. It also let them measure
 * somebody else's despatches, because `assertCustomerReturnWithinShipped`
 * below reads that shipment's lines on their behalf and the refusal names the
 * quantity.
 *
 * OR, NOT AND, and that is the list's rule rather than a looser reading of
 * it: `returnInScope` attributes a return through the order OR the shipment,
 * so a return this caller could SEE is a return they may create. Asking of
 * each document independently would be stricter than the list and would
 * refuse real work — `inv_sales_orders.warehouse_id` is nullable, so an order
 * booked before it was allocated carries none at all, and the operator who
 * then shipped it out of their own warehouse would be refused a return
 * against the pair. The transfer's source/destination asymmetry does not
 * transfer here: these two ids are not two ends of a movement, they are two
 * spellings of one anchor.
 *
 * `clientId` is not asked about — a customer is not a building.
 *
 * The NULL rule falls out of the same expression rather than being restated:
 * `NULL IN (…)` is NULL, so a document attributed to no warehouse anchors
 * this return to none of the caller's, exactly as it is excluded from their
 * list.
 *
 * 404 (§4), and it does not say which of the two documents failed. The org
 * checks in front of it have already told this caller both ids exist in their
 * tenant; naming the one that sits outside their warehouses would add the
 * single fact the gate exists to withhold.
 */
async function assertSourceInScope(
  deps: ReturnCreateDeps,
  orgId: string,
  userId: string,
  source: { soId?: number | null; shipmentId?: number | null },
): Promise<void> {
  // A walk-in return cites no document at all. `assertCustomerReturnWithinShipped`
  // makes the same exception for the same reason: there is nothing to measure
  // it against, and nothing to attribute it to either.
  if (source.soId == null && source.shipmentId == null) return;

  const scope = await deps.warehouseScope.forUser(orgId, userId);
  // Asked before the queries rather than compiled to `TRUE` inside them: an
  // org-wide caller is the common case on this path and two round trips to
  // learn nothing is two too many.
  if (scope.unrestricted) return;

  if (source.soId != null) {
    const [inScope] = await deps.db
      .select({ id: invSalesOrders.id })
      .from(invSalesOrders)
      .where(and(
        eq(invSalesOrders.id, source.soId),
        eq(invSalesOrders.orgId, orgId),
        scope.warehouse(sql`${invSalesOrders.warehouseId}`),
      ))
      .limit(1);
    if (inScope) return;
  }

  if (source.shipmentId != null) {
    const [inScope] = await deps.db
      .select({ id: invShipments.id })
      .from(invShipments)
      .where(and(
        eq(invShipments.id, source.shipmentId),
        eq(invShipments.orgId, orgId),
        scope.warehouse(sql`${invShipments.warehouseId}`),
      ))
      .limit(1);
    if (inScope) return;
  }

  throw new NotFoundException("Sales order or shipment not found");
}
