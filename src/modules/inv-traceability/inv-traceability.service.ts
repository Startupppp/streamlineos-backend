import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, lte, or, sql } from "drizzle-orm";
import {
  invLots,
  invSerialNumbers,
  invStockLevels,
  invStockTransactions,
  invProductVariants,
  invProducts,
  invLocations,
  invWarehouses,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import type { ListLotsInput, ListSerialsInput, UpdateLotStatusInput } from "./dto/traceability.schemas";

@Injectable()
export class InvTraceabilityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listLots(orgId: string, filters: ListLotsInput) {
    const { variantId, productId, status, expiringWithinDays, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invLots.orgId, orgId)];

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

  async getLotDetail(orgId: string, lotId: number) {
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
        .where(and(eq(invStockLevels.lotId, lotId), eq(invStockLevels.orgId, orgId))),
      this.db.query.invStockTransactions.findMany({
        where: and(eq(invStockTransactions.lotId, lotId), eq(invStockTransactions.orgId, orgId)),
        orderBy: [desc(invStockTransactions.createdAt)],
        limit: 50,
        with: { location: { columns: { id: true, name: true, code: true } } },
      }),
    ]);

    return { lot, stockByLocation, movements };
  }

  async updateLotStatus(orgId: string, lotId: number, body: UpdateLotStatusInput) {
    const lot = await this.db.query.invLots.findFirst({
      where: and(eq(invLots.id, lotId), eq(invLots.orgId, orgId)),
    });
    if (!lot) throw new NotFoundException("Lot not found");

    const [updated] = await this.db
      .update(invLots)
      .set({ status: body.status, updatedAt: new Date() })
      .where(and(eq(invLots.id, lotId), eq(invLots.orgId, orgId)))
      .returning();

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.invLotDetail(orgId, lotId)),
      this.cache.invalidatePattern(CACHE_KEYS.invLotsListPattern(orgId)),
    ]);
    return updated;
  }

  async listSerials(orgId: string, filters: ListSerialsInput) {
    const { variantId, status, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invSerialNumbers.orgId, orgId)];

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

  async getSerialDetail(orgId: string, serialId: number) {
    const serial = await this.db.query.invSerialNumbers.findFirst({
      where: and(eq(invSerialNumbers.id, serialId), eq(invSerialNumbers.orgId, orgId)),
      with: {
        productVariant: { with: { product: true } },
        currentLocation: { with: { warehouse: true } },
      },
    });
    if (!serial) throw new NotFoundException("Serial number not found");

    const movements = await this.db.query.invStockTransactions.findMany({
      where: and(eq(invStockTransactions.serialId, serialId), eq(invStockTransactions.orgId, orgId)),
      orderBy: [desc(invStockTransactions.createdAt)],
      limit: 50,
      with: { location: { columns: { id: true, name: true, code: true } } },
    });

    return { serial, movements };
  }

  async getExpiryReport(
    orgId: string,
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

    const baseWhere = and(
      eq(invLots.orgId, orgId),
      or(lte(invLots.expiryDate, cutoff), lte(invLots.expiryDate, today)),
      sql`(
        SELECT COALESCE(SUM(sl.on_hand::numeric), 0)
        FROM inv_stock_levels sl
        WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}
      ) > 0`,
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
        totalOnHand: sql<string>`COALESCE((
          SELECT SUM(sl.on_hand::numeric)
          FROM inv_stock_levels sl
          WHERE sl.lot_id = ${invLots.id} AND sl.org_id = ${orgId}
        ), 0)::text`,
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
