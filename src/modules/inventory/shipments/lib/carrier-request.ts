import { and, eq } from "drizzle-orm";
import { invPackages, invSalesOrders } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { applyEvent, type CarrierApplyDeps } from "./carrier-events";
import type { CarrierParcel } from "../transport/carrier-transport.port";
import type { CarrierStatusInput } from "../dto/carrier-status.schemas";

/**
 * INV-26 — what we hand a courier, and what we do with what it hands back.
 *
 * Both halves are queries over tables that belong to other parts of inventory
 * (`inv_packages`, `inv_sales_orders`), so they sit here rather than in the
 * transport service: the service decides *whether* to call a courier, and this
 * decides what a call is made of.
 */

/**
 * The cartons on a shipment, exactly as `inv_packages` stores them.
 *
 * No unit conversion, deliberately. `inv_packages.weight` is `numeric(18,4)`
 * and the column declares nowhere whether a warehouse entered grams or
 * kilograms, so converting here would be a silent hundredfold error on a
 * courier invoice. The decision belongs to the one place that can make it
 * correctly — a real courier's adapter, per tenant.
 */
export async function parcelsForShipment(
  db: Db,
  orgId: string,
  shipmentId: number,
): Promise<CarrierParcel[]> {
  const rows = await db
    .select({
      packageNumber: invPackages.packageNumber,
      weight: invPackages.weight,
      dimensionsL: invPackages.dimensionsL,
      dimensionsW: invPackages.dimensionsW,
      dimensionsH: invPackages.dimensionsH,
    })
    .from(invPackages)
    .where(and(eq(invPackages.orgId, orgId), eq(invPackages.shipmentId, shipmentId)))
    .orderBy(invPackages.id)
    // A consignment with more cartons than this is not what a parcel courier's
    // API is for; the cap stops one runaway shipment turning a booking into an
    // unbounded request body.
    .limit(200);

  return rows.map((row) => ({
    reference: row.packageNumber,
    declaredWeight: row.weight,
    declaredLength: row.dimensionsL,
    declaredWidth: row.dimensionsW,
    declaredHeight: row.dimensionsH,
  }));
}

/**
 * Where the parcel is going.
 *
 * Free text, because `inv_sales_orders.shipping_address` is one text column.
 * A structured address is a real gap for a real courier — every one of them
 * wants a postcode field — and it is a schema change in sales orders rather
 * than something to synthesise here by splitting on commas.
 */
export async function destinationForOrder(
  db: Db,
  orgId: string,
  soId: number | null,
): Promise<string | null> {
  if (!soId) return null;
  const [order] = await db
    .select({ shippingAddress: invSalesOrders.shippingAddress })
    .from(invSalesOrders)
    .where(and(eq(invSalesOrders.orgId, orgId), eq(invSalesOrders.id, soId)))
    .limit(1);
  return order?.shippingAddress ?? null;
}

/**
 * Folds a batch of tracking events into the shipment, and counts what was new.
 *
 * The status is carried forward through the loop rather than read once, for
 * `refreshTracking`'s reason: a poll returns a *batch*, couriers batch them in
 * whatever order their queue drained, and applying each against the status the
 * shipment had before the batch started would let a DELIVERED followed by an
 * earlier out-of-order scan walk the shipment backwards — the one thing the
 * monotonic rule exists to stop.
 */
export async function applyTrackingBatch(
  deps: CarrierApplyDeps,
  orgId: string,
  userId: string | null,
  shipment: { id: number; status: string; carrierId: number | null },
  trackingNumber: string,
  events: readonly CarrierStatusInput[],
): Promise<number> {
  let recorded = 0;
  let status: string = shipment.status;
  for (const event of events) {
    // The courier does not get to say which parcel this is about. An event for
    // a tracking number we did not ask about is naming somebody else's
    // shipment, so it is dropped rather than applied.
    if (event.trackingNumber !== trackingNumber) continue;
    const applied = await applyEvent(
      deps,
      orgId,
      userId,
      { id: shipment.id, status, carrierId: shipment.carrierId },
      event,
    );
    if (applied.recorded) recorded += 1;
    status = applied.status;
  }
  return recorded;
}
