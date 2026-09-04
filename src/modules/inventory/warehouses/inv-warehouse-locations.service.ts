import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { invWarehouses, invLocations, invStockLevels, invProductVariants, invProducts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import type { CreateLocationInput, UpdateLocationInput } from "./dto/inv-warehouses.schemas";

const LOCATION_PAGE_LIMIT = 100;

@Injectable()
export class InvWarehouseLocationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private async assertWarehouseInOrg(orgId: string, warehouseId: number): Promise<void> {
    const wh = await this.db.query.invWarehouses.findFirst({
      where: and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)),
      columns: { id: true },
    });
    if (!wh) throw new NotFoundException("Warehouse not found");
  }

  async listLocations(orgId: string, warehouseId: number, page = 1, limit = LOCATION_PAGE_LIMIT) {
    const boundedLimit = Math.min(limit, LOCATION_PAGE_LIMIT);
    const offset = (page - 1) * boundedLimit;
    return this.db.query.invLocations.findMany({
      where: and(eq(invLocations.warehouseId, warehouseId), eq(invLocations.orgId, orgId)),
      orderBy: (t, { asc: a }) => [a(t.code)],
      limit: boundedLimit,
      offset,
    });
  }

  async createLocation(orgId: string, warehouseId: number, data: CreateLocationInput) {
    await this.assertWarehouseInOrg(orgId, warehouseId);

    const existing = await this.db.query.invLocations.findFirst({
      where: and(eq(invLocations.warehouseId, warehouseId), eq(invLocations.code, data.code)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A location with this code already exists in this warehouse");

    const [loc] = await this.db.insert(invLocations).values({ orgId, warehouseId, ...data }).returning();
    return loc!;
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
    await this.assertWarehouseInOrg(orgId, warehouseId);

    return this.cache.cachedVersioned(`inv:stock:levels:${orgId}`, `wh:${warehouseId}:${page}:${limit}`, async () => {
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
