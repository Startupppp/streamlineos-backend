import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  invGrns,
  invSerialNumbers,
  invStockLevels,
  invVendorReturnLines,
  invVendorReturns,
} from "../../../../db/schema";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { type Db } from "../../../../db/drizzle.module";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../../stock-engine/warehouse-scope.service";
import { assertVendorReturnWithinReceived } from "../returnable-quantity";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type VendorReturnLineRow = typeof invVendorReturnLines.$inferSelect;

/**
 * The scope predicate and the three validations a vendor return passes through,
 * lifted out of `vendor-returns.service.ts` unchanged.
 *
 * What deliberately did NOT move: `loadVendorReturnUnscoped` and its
 * `loadVendorReturn` base. That is the read without the warehouse gate, for the
 * paths entitled to it, and `vendor-return-detail-scope.spec.ts` pins its exact
 * call form in the service source. Both stay on the class.
 *
 * The `.returnInScope(`, `.assertSourceInScope(` and `.assertReturnableInTx(`
 * hits in customer-returns.service.ts are that service calling its OWN methods of
 * those names, not shared API — checked before moving.
 */
  /**
   * Which vendor returns this caller may see — the list's rule, now the only
   * copy of it.
   *
   * Attributable through the receipt it is sending back, and through nothing
   * else. The GRN names a LOCATION rather than a warehouse, so this goes through
   * `scope.location`, which is a different predicate from the customer half's
   * `scope.warehouse` — matching each aggregate rather than a house default.
   *
   * The NULL rule: a NULL `grn_id` makes `NULL IN (…)` NULL, so a vendor return
   * raised against no receipt is **excluded** from a scoped caller's view. Not
   * the ASN rule, where an unattributed row stays visible to everyone — there a
   * null warehouse means "not known yet", here it means the return is anchored
   * to no receipt and so to no warehouse.
   */
export function returnInScope(orgId: string, scope: ResolvedWarehouseScope): SQL {
    return scope.anyOf(
      sql`${invVendorReturns.grnId} IN (SELECT id FROM inv_grns WHERE org_id = ${orgId} AND ${scope.location(sql.raw("location_id"))})`,
    );
  }

  /**
   * You may send goods back only off a receipt taken into a warehouse you hold.
   *
   * `create` validated `grn_id` against the ORG and stopped there, so a scoped
   * operator could anchor a DRAFT RMA to a receipt booked into another
   * warehouse. Nothing moved — a DRAFT posts no stock — and every step after it
   * is gated, so the document was invisible to its own author the moment it was
   * saved: a write into a building they hold nothing in, leaving an orphaned
   * draft behind. It also let them measure somebody else's intake, because
   * `assertVendorReturnWithinReceived` below reads that GRN's lines on their
   * behalf and the refusal names the quantity.
   *
   * Through the GRN's LOCATION, matching `returnInScope` above rather than the
   * customer half's `scope.warehouse` — a receipt names the bin it landed in,
   * not the building.
   *
   * `poId` IS DELIBERATELY NOT ASKED ABOUT, the way a transfer asks about its
   * source and not its destination. A vendor return is attributable through the
   * receipt and through nothing else — that is the list's rule and this is the
   * same rule — and a purchase order is raised centrally, so requiring the
   * warehouse operator sending faulty goods back to also hold whatever the PO
   * was attributed to would refuse the ordinary case. `vendorId` is not asked
   * about either: a supplier is not a building. If that is wrong it is wrong as
   * a decision — a spec asserts the PO is not consulted, so tightening it later
   * has to be deliberate rather than drifted into.
   *
   * The NULL rule falls out of the expression rather than being restated: a
   * receipt with no location anchors this return to none of the caller's
   * warehouses, exactly as it is excluded from their list.
   *
   * 404 (§4). The org check in front of it has already told this caller the id
   * exists in their tenant, so the refusal adds nothing by explaining itself.
   */
export async function assertSourceInScope(
    db: Db,
    warehouseScope: WarehouseScopeService,
    orgId: string,
    userId: string,
    grnId: number | null | undefined,
  ): Promise<void> {
    // An RMA raised against no receipt at all. `assertVendorReturnWithinReceived`
    // makes the same exception: nothing to measure it against, nothing to
    // attribute it to either.
    if (grnId == null) return;

    const scope = await warehouseScope.forUser(orgId, userId);
    // Asked before the query rather than compiled to `TRUE` inside it: an
    // org-wide caller is the common case on this path.
    if (scope.unrestricted) return;

    const [inScope] = await db
      .select({ id: invGrns.id })
      .from(invGrns)
      .where(and(
        eq(invGrns.id, grnId),
        eq(invGrns.orgId, orgId),
        scope.location(sql`${invGrns.locationId}`),
      ))
      .limit(1);
    if (!inScope) throw new NotFoundException("GRN not found");
  }

export function assertReturnableInTx(
    tx: Tx,
    orgId: string,
    grnId: number | null,
    lines: VendorReturnLineRow[],
  ): Promise<void> {
    return assertVendorReturnWithinReceived(
      tx,
      orgId,
      grnId === null ? null : Number(grnId),
      lines,
    );
  }

export async function resolveLineLocation(
    tx: Tx,
    orgId: string,
    line: VendorReturnLineRow,
  ): Promise<number> {
    if (line.serialId) {
      const serial = await tx.query.invSerialNumbers.findFirst({
        where: and(
          eq(invSerialNumbers.id, line.serialId),
          eq(invSerialNumbers.orgId, orgId),
        ),
        columns: { currentLocationId: true },
      });
      if (serial?.currentLocationId) return serial.currentLocationId;
    }

    const stockLevel = await tx.query.invStockLevels.findFirst({
      where: and(
        eq(invStockLevels.orgId, orgId),
        eq(invStockLevels.productVariantId, line.productVariantId),
        line.lotId ? eq(invStockLevels.lotId, line.lotId) : undefined,
      ),
      columns: { locationId: true },
      orderBy: (t, { desc }) => [desc(t.onHand)],
    });

    if (stockLevel?.locationId) return stockLevel.locationId;
    throw new BadRequestException(`Cannot determine location for variant ${line.productVariantId} in vendor return`);
  }
