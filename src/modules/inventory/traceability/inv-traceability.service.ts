import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import {
  invLots,
  invSerialNumbers,
  invStockLevels,
  invStockTransactions,
  invProductVariants,
  invProducts,
  invLocations,
  invWarehouses,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import type { ListLotsInput, ListSerialsInput, UpdateLotStatusInput } from "./dto/traceability.schemas";

@Injectable()
export class InvTraceabilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listLots(orgId: string, userId: string, filters: ListLotsInput) {
    const { variantId, productId, status, expiringWithinDays, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const conditions = [eq(invLots.orgId, orgId)];

    // INV-109. A lot carries no warehouse or location column of its own, which
    // is why it was left unscoped -- but it is attributable through the stock
    // it holds, the same way a serial is attributable through its location and
    // a package through its shipment.
    //
    // The decision this encodes: a lot with stock in a warehouse the operator
    // holds is theirs to see; a lot with stock *nowhere* is attributable to no
    // warehouse and stays out of a scoped list. That is the same rule already
    // applied to serials, packages and returns, and it fails closed -- an
    // unattributable row is hidden rather than shown.
    if (!scope.unrestricted) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM inv_stock_levels sl
          WHERE sl.org_id = ${orgId}
            AND sl.lot_id = ${invLots.id}
            AND ${scope.location(sql`sl.location_id`)}
        )`,
      );
    }

    if (variantId != null) conditions.push(eq(invLots.productVariantId, variantId));
    if (status) conditions.push(eq(invLots.status, status));
    if (search) conditions.push(ilike(invLots.lotNumber, `%${search}%`));
    if (expiringWithinDays != null) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + expiringWithinDays);
      conditions.push(lte(invLots.expiryDate, cutoff.toISOString().slice(0, 10)));
    }

    const productIdCondition =
      productId != null
        ? inArray(
            invLots.productVariantId,
            this.db
              .select({ id: invProductVariants.id })
              .from(invProductVariants)
              .where(eq(invProductVariants.productId, productId)),
          )
        : null;
    if (productIdCondition) conditions.push(productIdCondition);

    const where = and(...conditions);

    const [items, countRows] = await Promise.all([
      this.db
        .select({
          id: invLots.id,
          orgId: invLots.orgId,
          productVariantId: invLots.productVariantId,
          lotNumber: invLots.lotNumber,
          manufactureDate: invLots.manufactureDate,
          expiryDate: invLots.expiryDate,
          supplierLotNumber: invLots.supplierLotNumber,
          status: invLots.status,
          qualityStatus: invLots.qualityStatus,
          createdAt: invLots.createdAt,
          variantSku: invProductVariants.sku,
          variantName: invProductVariants.name,
          productId: invProducts.id,
          productName: invProducts.name,
          productSku: invProducts.sku,
          totalOnHand: sql<string>`COALESCE((
            SELECT SUM(sl.on_hand::numeric)
            FROM inv_stock_levels sl
            WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}
          ), 0)::text`,
        })
        .from(invLots)
        .innerJoin(invProductVariants, eq(invLots.productVariantId, invProductVariants.id))
        .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
        .where(where)
        .orderBy(desc(invLots.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::int` }).from(invLots).where(where),
    ]);

    return { items, total: countRows[0]?.total ?? 0, page, totalPages: Math.ceil((countRows[0]?.total ?? 0) / limit) };
  }

  /**
   * The gate `listLots` has had since INV-109 and the two methods below it did not.
   *
   * A lot carries no warehouse or location column of its own; it is attributable
   * through the stock it holds. `listLots` encodes that and says so at length --
   * a lot with stock in a warehouse you hold is yours, a lot with stock nowhere
   * is attributable to none and stays hidden. This is that same predicate, so
   * the detail and its aggregate agree rather than each inventing a rule.
   *
   * 404 rather than 403: a 403 on a lot number the caller may not see confirms
   * the lot exists, which is enough to probe another building's inventory.
   */
  private async requireLot(orgId: string, userId: string, lotId: number): Promise<void> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.unrestricted) return;

    const [visible] = await this.db
      .select({ id: invLots.id })
      .from(invLots)
      .where(and(
        eq(invLots.id, lotId),
        eq(invLots.orgId, orgId),
        sql`EXISTS (
          SELECT 1 FROM inv_stock_levels sl
          WHERE sl.org_id = ${orgId}
            AND sl.lot_id = ${invLots.id}
            AND ${scope.location(sql`sl.location_id`)}
        )`,
      ))
      .limit(1);
    if (!visible) throw new NotFoundException("Lot not found");
  }

  async getLotDetail(orgId: string, userId: string, lotId: number) {
    await this.requireLot(orgId, userId, lotId);
    const scope = await this.warehouseScope.forUser(orgId, userId);

    const lot = await this.db.query.invLots.findFirst({
      where: and(eq(invLots.id, lotId), eq(invLots.orgId, orgId)),
      with: { productVariant: { with: { product: true } } },
    });
    if (!lot) throw new NotFoundException("Lot not found");

    const [stockByLocation, movements] = await Promise.all([
      this.db
        .select({
          locationId: invStockLevels.locationId,
          locationName: invLocations.name,
          locationCode: invLocations.code,
          warehouseId: invWarehouses.id,
          warehouseName: invWarehouses.name,
          onHand: invStockLevels.onHand,
          committed: invStockLevels.committed,
          blockedQty: invStockLevels.blockedQty,
        })
        .from(invStockLevels)
        .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
        .innerJoin(invWarehouses, eq(invLocations.warehouseId, invWarehouses.id))
        /*
          Scoped a second time, and not redundantly. The gate above decides
          whether the LOT is visible -- it is, as soon as any of its stock is in
          a warehouse the caller holds. This decides how much of the lot they
          see, and without it a single pallet in Pune would hand over the
          quantities, locations and warehouse NAMES of the same lot in every
          other building. Same deny-by-default direction as the list.
        */
        .where(and(
          eq(invStockLevels.lotId, lotId),
          eq(invStockLevels.orgId, orgId),
          scope.location(sql`${invStockLevels.locationId}`),
        )),
      this.db.query.invStockTransactions.findMany({
        where: and(
          eq(invStockTransactions.lotId, lotId),
          eq(invStockTransactions.orgId, orgId),
          scope.location(sql`${invStockTransactions.locationId}`),
        ),
        orderBy: [desc(invStockTransactions.createdAt)],
        limit: 50,
        with: { location: { columns: { id: true, name: true, code: true } } },
      }),
    ]);

    return { lot, stockByLocation, movements };
  }

  /**
   * Quarantining and releasing a lot, which anyone in the organisation could do
   * to any building's stock.
   *
   * This method took no caller id at all, so it could not scope whatever the
   * controller intended -- and the route behind it is `inventory:stock:adjust`,
   * held by every operator. Releasing a lot somebody else quarantined is the
   * sharp direction: the hold disappears, the stock becomes pickable again, and
   * the people who raised it are not told.
   */
  async updateLotStatus(orgId: string, userId: string, lotId: number, body: UpdateLotStatusInput) {
    await this.requireLot(orgId, userId, lotId);
    const lot = await this.db.query.invLots.findFirst({
      columns: { id: true },
      where: and(eq(invLots.id, lotId), eq(invLots.orgId, orgId)),
    });
    if (!lot) throw new NotFoundException("Lot not found");

    const [updated] = await this.db
      .update(invLots)
      .set({ status: body.status, updatedAt: new Date() })
      .where(and(eq(invLots.id, lotId), eq(invLots.orgId, orgId)))
      .returning();

    // Lot list/detail are direct DB reads. Only the cached trace chain needs a
    // generation bump when status changes.
    await this.cache.invalidateNamespace(`inv:traceability:${orgId}`);
    return updated;
  }

  /**
   * Which serials this caller may see — the list's rule, now the only copy.
   *
   * A serial sits at a location, so it is scopeable directly. `location_id IN
   * (SELECT …)` is NULL for a serial standing nowhere, so an unattributed serial
   * is EXCLUDED for a scoped operator — which is exactly what this list has
   * always done, and is deliberately not the ASN's rule, where an unattributed
   * row stays visible because its warehouse may not be known yet. A serial
   * without a location has been shipped, consumed or never received; it is not a
   * document waiting for somebody to place it.
   */
  private serialInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.location(sql`${invSerialNumbers.currentLocationId}`);
  }

  async listSerials(orgId: string, userId: string, filters: ListSerialsInput) {
    const { variantId, status, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    // A serial sits at a location, so it is scopeable directly. A serial with no
    // location is attributable to no warehouse and stays out of a scoped list.
    const conditions = [
      eq(invSerialNumbers.orgId, orgId),
      this.serialInScope(scope),
    ];

    if (variantId != null) conditions.push(eq(invSerialNumbers.productVariantId, variantId));
    if (status) conditions.push(eq(invSerialNumbers.status, status));
    if (search) {
      conditions.push(ilike(invSerialNumbers.serialNumber, `%${search}%`));
    }

    const where = and(...conditions);
    const [items, countRows] = await Promise.all([
      this.db
        .select({
          id: invSerialNumbers.id,
          serialNumber: invSerialNumbers.serialNumber,
          lotId: invSerialNumbers.lotId,
          status: invSerialNumbers.status,
          currentLocationId: invSerialNumbers.currentLocationId,
          productVariantId: invSerialNumbers.productVariantId,
          createdAt: invSerialNumbers.createdAt,
          variantSku: invProductVariants.sku,
          variantName: invProductVariants.name,
          productId: invProducts.id,
          productName: invProducts.name,
          currentLocationName: invLocations.name,
          currentLocationCode: invLocations.code,
        })
        .from(invSerialNumbers)
        .innerJoin(invProductVariants, eq(invSerialNumbers.productVariantId, invProductVariants.id))
        .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
        .leftJoin(invLocations, eq(invSerialNumbers.currentLocationId, invLocations.id))
        .where(where)
        .orderBy(desc(invSerialNumbers.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: sql<number>`count(*)::int` }).from(invSerialNumbers).where(where),
    ]);

    return { items, total: countRows[0]?.total ?? 0, page, totalPages: Math.ceil((countRows[0]?.total ?? 0) / limit) };
  }

  /**
   * One serial, its whole history, and — until now — anybody's serial.
   *
   * `listSerials` beside it resolves the caller's warehouses and `listLots`,
   * `getLotDetail` and `requireLot` all narrow through the stock that stands
   * against them. This took no `userId` at all, because the controller had
   * `@CurrentUser()` in hand and passed only `orgId`. So a serial an operator
   * could not see in their list was theirs to read whole: where the unit is
   * standing right now, which building that bin is in, and the last fifty
   * movements it made — a complete account of one item's passage through a site
   * they have never worked in.
   *
   * The movements are narrowed by the same scope rather than only by the serial,
   * because the point of the read is the history: a serial that has passed
   * through three warehouses would otherwise report all three to somebody
   * entitled to one. The engine's `assertLocationsInScope` is no help on either
   * half — a read posts nothing.
   *
   * Not cached, so there is no key to carry a scope discriminator; if one is
   * ever added it must carry `scope.key` (§6).
   */
  async getSerialDetail(orgId: string, userId: string, serialId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const serial = await this.db.query.invSerialNumbers.findFirst({
      where: and(
        eq(invSerialNumbers.id, serialId),
        eq(invSerialNumbers.orgId, orgId),
        this.serialInScope(scope),
      ),
      with: {
        productVariant: { with: { product: true } },
        currentLocation: { with: { warehouse: true } },
      },
    });
    // 404 rather than 403: a "forbidden" on a serial id confirms the serial
    // exists, which turns a probe into an existence oracle (§4).
    if (!serial) throw new NotFoundException("Serial number not found");

    const movements = await this.db.query.invStockTransactions.findMany({
      where: and(
        eq(invStockTransactions.serialId, serialId),
        eq(invStockTransactions.orgId, orgId),
        scope.location(sql`${invStockTransactions.locationId}`),
      ),
      orderBy: [desc(invStockTransactions.createdAt)],
      limit: 50,
      with: { location: { columns: { id: true, name: true, code: true } } },
    });

    return { serial, movements };
  }

  /**
   * Lots about to expire, and how much of each is on hand.
   *
   * The rule this now follows is not invented here: `InvReportsExtendedService`
   * carries a scoped expiry report of its own, and the reason is written into
   * it — a lot itself carries no location, its STOCK does, so the warehouse
   * predicate constrains the same existence check that already proves the lot is
   * worth listing. A lot is listed only where the caller can see the stock that
   * makes it worth listing. This copy, on `/inventory/traceability/expiry`,
   * simply took no `userId` and reported every site's expiring goods with their
   * quantities to anyone holding the stock-read key.
   *
   * `totalOnHand` is narrowed by the same predicate rather than left summing the
   * organisation. Reporting the whole quantity beside a row admitted on one
   * warehouse's stock would leak the size of the others through the number
   * itself, which is the same disclosure by a quieter route.
   */
  async getExpiryReport(
    orgId: string,
    userId: string,
    withinDays: number,
    page = 1,
    limit = 100,
  ) {
    const safeLimit = Math.min(limit, 100);
    const offset = (page - 1) * safeLimit;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + withinDays);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const scope = await this.warehouseScope.forUser(orgId, userId);
    const visibleOnHand = sql`COALESCE((
        SELECT SUM(sl.on_hand::numeric)
        FROM inv_stock_levels sl
        WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}
          AND ${scope.location(sql`sl.location_id`)}
      ), 0)`;

    const baseWhere = and(
      eq(invLots.orgId, orgId),
      or(lte(invLots.expiryDate, cutoff), lte(invLots.expiryDate, today)),
      sql`${visibleOnHand} > 0`,
    );

    const items = await this.db
      .select({
        id: invLots.id,
        lotNumber: invLots.lotNumber,
        expiryDate: invLots.expiryDate,
        status: invLots.status,
        productVariantId: invLots.productVariantId,
        variantSku: invProductVariants.sku,
        variantName: invProductVariants.name,
        productId: invProducts.id,
        productName: invProducts.name,
        totalOnHand: sql<string>`${visibleOnHand}::text`,
        daysUntilExpiry: sql<number>`EXTRACT(DAY FROM (${invLots.expiryDate}::date - CURRENT_DATE))::int`,
      })
      .from(invLots)
      .innerJoin(invProductVariants, eq(invLots.productVariantId, invProductVariants.id))
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .where(baseWhere)
      .orderBy(invLots.expiryDate)
      .limit(safeLimit)
      .offset(offset);

    return items;
  }
}
