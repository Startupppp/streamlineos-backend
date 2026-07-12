import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { invWarehouses, invLocations, invStockLevels, invProductVariants, invProducts } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { CreateWarehouseInput, UpdateWarehouseInput, CreateLocationInput, UpdateLocationInput } from "./dto/inv-warehouses.schemas";

@Injectable()
export class InvWarehousesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  listWarehouses(orgId: string) {
    return this.cache.cached(CACHE_KEYS.invWarehousesList(orgId), () =>
      this.db.query.invWarehouses.findMany({
        where: eq(invWarehouses.orgId, orgId),
        with: { locations: true },
        orderBy: (t, { asc: a }) => [a(t.name)],
        limit: 200,
      }),
      CACHE_TTL.MEDIUM
    );
  }

  async getWarehouse(orgId: string, warehouseId: number) {
    const wh = await this.db.query.invWarehouses.findFirst({
      where: and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)),
      with: { locations: { with: { children: true } } },
    });
    if (!wh) throw new NotFoundException("Warehouse not found");
    return wh;
  }

  async createWarehouse(orgId: string, userId: string, data: CreateWarehouseInput) {
    const existing = await this.db.query.invWarehouses.findFirst({
      where: and(eq(invWarehouses.orgId, orgId), eq(invWarehouses.code, data.code)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A warehouse with this code already exists");

    if (data.isDefault) {
      await this.db.update(invWarehouses)
        .set({ isDefault: false })
        .where(eq(invWarehouses.orgId, orgId));
    }

    const [wh] = await this.db.insert(invWarehouses).values({ orgId, createdBy: userId, ...data }).returning();

    await this.db.insert(invLocations).values([
      { orgId, warehouseId: wh.id, name: "Main", code: "MAIN", locationType: "ZONE" },
      { orgId, warehouseId: wh.id, name: "Receiving", code: "RECEIVING", locationType: "RECEIVING", isReceivable: true, isPickable: false },
      { orgId, warehouseId: wh.id, name: "Shipping", code: "SHIPPING", locationType: "SHIPPING", isReceivable: false, isPickable: true },
      { orgId, warehouseId: wh.id, name: "Quarantine", code: "QUARANTINE", locationType: "QUARANTINE", isReceivable: false, isPickable: false },
      { orgId, warehouseId: wh.id, name: "Scrap", code: "SCRAP", locationType: "SCRAP", isReceivable: false, isPickable: false },
    ]);

    await this.cache.del(CACHE_KEYS.invWarehousesList(orgId));
    return wh;
  }

  async updateWarehouse(orgId: string, warehouseId: number, data: UpdateWarehouseInput) {
    if (data.isActive === false) {
      const locations = await this.db
        .select({ id: invLocations.id })
        .from(invLocations)
        .where(eq(invLocations.warehouseId, warehouseId));

      if (locations.length > 0) {
        const locationIds = locations.map(l => l.id);
        const [stockRow] = await this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(invStockLevels)
          .where(and(
            inArray(invStockLevels.locationId, locationIds),
            gt(invStockLevels.onHand, "0")
          ));
        if ((stockRow?.count ?? 0) > 0) {
          throw new ConflictException("Cannot deactivate warehouse with existing stock");
        }
      }
    }

    if (data.isDefault) {
      await this.db.update(invWarehouses)
        .set({ isDefault: false })
        .where(eq(invWarehouses.orgId, orgId));
    }

    const [updated] = await this.db.update(invWarehouses)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Warehouse not found");

    await this.cache.del(CACHE_KEYS.invWarehousesList(orgId));
    await this.cache.del(CACHE_KEYS.invWarehouseDetail(orgId, warehouseId));
    return updated;
  }

  async listLocations(orgId: string, warehouseId: number) {
    return this.db.query.invLocations.findMany({
      where: and(eq(invLocations.warehouseId, warehouseId), eq(invLocations.orgId, orgId)),
      orderBy: (t, { asc: a }) => [a(t.code)],
      limit: 200,
    });
  }

  async createLocation(orgId: string, warehouseId: number, data: CreateLocationInput) {
    const wh = await this.db.query.invWarehouses.findFirst({
      where: and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)),
      columns: { id: true },
    });
    if (!wh) throw new NotFoundException("Warehouse not found");

    const existing = await this.db.query.invLocations.findFirst({
      where: and(eq(invLocations.warehouseId, warehouseId), eq(invLocations.code, data.code)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A location with this code already exists in this warehouse");

    const [loc] = await this.db.insert(invLocations).values({ orgId, warehouseId, ...data }).returning();
    return loc;
  }

  async updateLocation(orgId: string, locationId: number, data: UpdateLocationInput) {
    if (data.isActive === false) {
      const [stockRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockLevels)
        .where(and(
          eq(invStockLevels.locationId, locationId),
          gt(invStockLevels.onHand, "0")
        ));
      if ((stockRow?.count ?? 0) > 0) {
        throw new ConflictException("Cannot deactivate location with existing stock");
      }
    }

    const [updated] = await this.db.update(invLocations)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invLocations.id, locationId), eq(invLocations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Location not found");
    return updated;
  }

  async getWarehouseStock(orgId: string, warehouseId: number, page: number, limit: number) {
    const wh = await this.db.query.invWarehouses.findFirst({
      where: and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)),
      columns: { id: true },
    });
    if (!wh) throw new NotFoundException("Warehouse not found");

    const cacheKey = CACHE_KEYS.invStockLevels(orgId, `wh:${warehouseId}:${page}:${limit}`);
    return this.cache.cached(cacheKey, async () => {
      const offset = (page - 1) * limit;
      const stockWhere = and(
        eq(invLocations.warehouseId, warehouseId),
        eq(invLocations.orgId, orgId),
        gt(invStockLevels.onHand, "0")
      );

      const [items, countResult] = await Promise.all([
        this.db
          .select({
            locationId: invLocations.id,
            locationCode: invLocations.code,
            locationName: invLocations.name,
            productVariantId: invStockLevels.productVariantId,
            variantSku: invProductVariants.sku,
            variantName: invProductVariants.name,
            productId: invProducts.id,
            productName: invProducts.name,
            onHand: invStockLevels.onHand,
            committed: invStockLevels.committed,
            onOrder: invStockLevels.onOrder,
          })
          .from(invStockLevels)
          .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
          .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
          .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
          .where(stockWhere)
          .orderBy(asc(invLocations.code), asc(invProductVariants.sku))
          .limit(limit)
          .offset(offset),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(invStockLevels)
          .innerJoin(invLocations, eq(invStockLevels.locationId, invLocations.id))
          .where(stockWhere),
      ]);

      const total = countResult[0]?.count ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }
}
