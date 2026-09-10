import { and, eq, sql } from "drizzle-orm";
import { invCartonTypes, invSalesOrders, invShipments } from "../../../../db/schema";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { InvBarcodeService } from "../../barcode/inv-barcode.service";
import type { ScanIntoPackageInput } from "../dto/shipments.schemas";

/**
 * Resolving and scope-asserting the things a package is packed against — the
 * sales order behind it, the shipment it belongs to, the carton type, and a
 * scanned payload. Lifted out of `packages.service.ts` unchanged.
 *
 * All five were private with no caller outside that service (the one
 * `.resolveScan(` elsewhere is `pick-confirm.service.ts` calling its own). Each
 * takes only what it actually used, rather than the whole constructor: three of
 * them the db handle, two of those the warehouse scope, and `resolveScan` only
 * the barcode service.
 */
  /**
   * The order whose goods are in the carton.
   *
   * The package's own attribution first, because a package being packed has no
   * shipment yet; the shipment's is the fallback that keeps every package raised
   * before B6 reconciling exactly as it did.
   */
export async function resolveSoId(
    db: Db,

    orgId: string,
    pkg: { soId: number | null; shipmentId: number | null },
  ): Promise<number | null> {
    if (pkg.soId !== null) return pkg.soId;
    if (pkg.shipmentId === null) return null;
    const [shipment] = await db
      .select({ soId: invShipments.soId })
      .from(invShipments)
      .where(and(eq(invShipments.id, pkg.shipmentId), eq(invShipments.orgId, orgId)))
      .limit(1);
    return shipment?.soId ?? null;
  }

  /**
   * The shipment a new carton may be hung off: this org's, and out of a building
   * the caller holds. Measured with `ShipmentsService`'s own predicate rather
   * than a second reading of it.
   */
export async function assertShipmentInScope(
    db: Db,
    warehouseScope: WarehouseScopeService,
orgId: string, userId: string, shipmentId: number): Promise<void> {
    const scope = await warehouseScope.forUser(orgId, userId);
    const [shipment] = await db
      .select({ id: invShipments.id })
      .from(invShipments)
      .where(and(
        eq(invShipments.id, shipmentId),
        eq(invShipments.orgId, orgId),
        scope.warehouse(sql`${invShipments.warehouseId}`),
      ))
      .limit(1);
    if (!shipment) throw new NotFoundException("Shipment not found");
  }

  /**
   * The order a new carton may be packing: this org's, and out of a building the
   * caller holds.
   *
   * The other arm of the same `anyOf` the list admits a package by, so it is
   * gated by the same rule for the same reason. `shipmentId` was closed and this
   * was left checking ORG MEMBERSHIP alone, which leaves the hole open through
   * the second arm: `packedQuantities` reads every package standing for an
   * order, so a carton hung off an out-of-scope order still counts toward that
   * order's packed quantities and can refuse the legitimate packer's next scan.
   *
   * Measured with the ORDER's own rule — its warehouse column, as
   * `SoCoreService` and `packageInScope` both read it — and answered 404 so
   * naming an id you cannot see does not confirm it exists. Unrestricted needs
   * no branch of its own: `scope.warehouse` compiles to `TRUE`, so the org check
   * is all that remains.
   */
export async function assertSalesOrderInScope(
    db: Db,
    warehouseScope: WarehouseScopeService,
orgId: string, userId: string, soId: number): Promise<void> {
    const scope = await warehouseScope.forUser(orgId, userId);
    const [so] = await db
      .select({ id: invSalesOrders.id })
      .from(invSalesOrders)
      .where(and(
        eq(invSalesOrders.id, soId),
        eq(invSalesOrders.orgId, orgId),
        scope.warehouse(sql`${invSalesOrders.warehouseId}`),
      ))
      .limit(1);
    if (!so) throw new NotFoundException("Sales order not found");
  }

export async function assertCartonType(
    db: Db,
orgId: string, cartonTypeId: number): Promise<void> {
    const [carton] = await db
      .select({ id: invCartonTypes.id })
      .from(invCartonTypes)
      .where(and(
        eq(invCartonTypes.id, cartonTypeId),
        eq(invCartonTypes.orgId, orgId),
        eq(invCartonTypes.isActive, true),
      ))
      .limit(1);
    if (!carton) throw new NotFoundException("Carton type not found");
  }

  /**
   * The goods one scan names.
   *
   * A lot or serial label identifies its variant as surely as a GTIN does, so
   * all three resolve here; the grain the label carries is kept, because a
   * manifest that lost the lot could not answer a recall.
   */
export async function resolveScan(
    barcode: InvBarcodeService,

    orgId: string,
    userId: string,
    input: ScanIntoPackageInput,
  ): Promise<{ productVariantId: number; lotId: number | null; serialId: number | null }> {
    const { scannedPayload, productVariantId } = input;
    if (scannedPayload === undefined) {
      // The keyboard fallback, for a label that will not read.
      if (productVariantId === undefined)
        throw new BadRequestException("Provide a scannedPayload or a productVariantId");
      return { productVariantId, lotId: null, serialId: null };
    }

    // `userId` only scopes the on-hand totals the scan reports; the packer
    // reads none of them. Identity stays organisation-wide, or a carton packed
    // from transferred stock would refuse its own goods.
    const scan = await barcode.scan(orgId, userId, scannedPayload);
    const variantId =
      scan.variant?.id ??
      (scan.lookup?.type === "variant" ? scan.lookup.variantId : null) ??
      (scan.lookup?.type === "lot" ? scan.lookup.variantId : null) ??
      (scan.lookup?.type === "serial" ? scan.lookup.variantId : null);
    if (variantId === null || variantId === undefined)
      throw new BadRequestException("That scan does not identify a product");

    if (productVariantId !== undefined && productVariantId !== variantId)
      throw new BadRequestException("Scanned item does not match the product given");

    return {
      productVariantId: variantId,
      lotId: scan.lot?.id ?? (scan.lookup?.type === "lot" ? scan.lookup.lotId : null) ?? null,
      serialId:
        scan.serial?.id ?? (scan.lookup?.type === "serial" ? scan.lookup.serialId : null) ?? null,
    };
  }
