import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, count, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { invWarehouses, invLocations, invStockLevels, invProductVariants, invProducts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService, type WarehouseScope } from "../stock-engine/warehouse-scope.service";
import { buildListResponse } from "../../../common/pagination/pagination";
import type { CreateWarehouseInput, UpdateWarehouseInput, CreateLocationInput, UpdateLocationInput, ListWarehousesInput } from "./dto/inv-warehouses.schemas";

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (c) => `\\${c}`);
}

const MAX_PAGE_LIMIT = 100;

@Injectable()
export class InvWarehousesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listWarehouses(orgId: string, userId: string, filters?: ListWarehousesInput) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    // The unfiltered list is cached per org, so the caller's scope has to be part
    // of the key or one operator's warehouses would be served to the next.
    const scopeKey = scope === null ? "all" : ([...scope].sort((a, b) => a - b).join(".") || "none");
    const hasFilters = filters && (filters.q || filters.status || filters.isDefault !== undefined || filters.country || filters.city);
    if (!hasFilters) {
      return this.cache.cachedVersionedForOrg(orgId, "inv:warehouses", scopeKey, () =>
        this.queryWarehouses(orgId, {}, scope),
        CACHE_TTL.MEDIUM
      );
    }
    return this.queryWarehouses(orgId, filters ?? {}, scope);
  }

  private async queryWarehouses(orgId: string, filters: Partial<ListWarehousesInput>, scope: WarehouseScope = null) {
    const conds = [eq(invWarehouses.orgId, orgId)];
    conds.push(this.warehouseScope.warehousePredicate(scope, sql`${invWarehouses.id}`));

    if (filters.q) {
      const term = `%${escapeLike(filters.q)}%`;
      conds.push(
        or(
          ilike(invWarehouses.name, term),
          ilike(invWarehouses.code, term),
          ilike(invWarehouses.city, term),
          ilike(invWarehouses.state, term),
          ilike(invWarehouses.country, term),
          ilike(invWarehouses.address, term),
        )!,
      );
    }
    if (filters.status === "active") conds.push(eq(invWarehouses.isActive, true));
    if (filters.status === "inactive") conds.push(eq(invWarehouses.isActive, false));
    if (filters.isDefault !== undefined) conds.push(eq(invWarehouses.isDefault, filters.isDefault));
    if (filters.country) conds.push(ilike(invWarehouses.country, filters.country));
    if (filters.city) conds.push(ilike(invWarehouses.city, filters.city));

    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const offset = (page - 1) * limit;

    const where = and(...conds);
    const [warehouses, [totalRow]] = await Promise.all([
      this.db
        .select({
          id: invWarehouses.id,
          orgId: invWarehouses.orgId,
          name: invWarehouses.name,
          code: invWarehouses.code,
          address: invWarehouses.address,
          city: invWarehouses.city,
          state: invWarehouses.state,
          country: invWarehouses.country,
          isDefault: invWarehouses.isDefault,
          isActive: invWarehouses.isActive,
          branchId: invWarehouses.branchId,
          managerUserId: invWarehouses.managerUserId,
          createdBy: invWarehouses.createdBy,
          createdAt: invWarehouses.createdAt,
          updatedAt: invWarehouses.updatedAt,
          locationCount: sql<number>`(SELECT COUNT(*) FROM inv_locations l WHERE l.warehouse_id = ${invWarehouses.id} AND l.org_id = ${invWarehouses.orgId})`,
        })
        .from(invWarehouses)
        .where(where)
        .orderBy(asc(invWarehouses.name))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(invWarehouses).where(where),
    ]);

    return buildListResponse(
      warehouses.map((wh) => ({
        ...wh,
        _count: { locations: Number(wh.locationCount) },
        locationCount: undefined,
      })),
      Number(totalRow?.total ?? 0),
      { page, pageSize: limit },
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
    const [existingCode, existingName] = await Promise.all([
      this.db.query.invWarehouses.findFirst({
        where: and(eq(invWarehouses.orgId, orgId), eq(invWarehouses.code, data.code)),
        columns: { id: true },
      }),
      this.db.query.invWarehouses.findFirst({
        where: and(eq(invWarehouses.orgId, orgId), ilike(invWarehouses.name, data.name)),
        columns: { id: true },
      }),
    ]);
    if (existingCode) throw new ConflictException("A warehouse with this code already exists");
    if (existingName) throw new ConflictException("A warehouse with this name already exists");

    if (data.isDefault) {
      await this.db.update(invWarehouses)
        .set({ isDefault: false })
        .where(eq(invWarehouses.orgId, orgId));
    }

    const [wh] = await this.db.insert(invWarehouses).values({ orgId, createdBy: userId, ...data }).returning();

    await this.db.insert(invLocations).values([
      { orgId, warehouseId: wh!.id, name: "Main", code: "MAIN", locationType: "ZONE" },
      { orgId, warehouseId: wh!.id, name: "Receiving", code: "RECEIVING", locationType: "RECEIVING", isReceivable: true, isPickable: false },
      { orgId, warehouseId: wh!.id, name: "Shipping", code: "SHIPPING", locationType: "SHIPPING", isReceivable: false, isPickable: true },
      { orgId, warehouseId: wh!.id, name: "Quarantine", code: "QUARANTINE", locationType: "QUARANTINE", isReceivable: false, isPickable: false },
      { orgId, warehouseId: wh!.id, name: "Scrap", code: "SCRAP", locationType: "SCRAP", isReceivable: false, isPickable: false },
    ]);

    await this.cache.invalidateNamespaceForOrg(orgId, "inv:warehouses");
    return wh!;
  }

  // B1-01 BOLA: pre-deactivation stock check now includes eq(invLocations.orgId, orgId).
  // B1-12: stock check + isDefault reset + update wrapped in one transaction.
  async updateWarehouse(orgId: string, warehouseId: number, data: UpdateWarehouseInput) {
    const updated = await this.db.transaction(async (tx) => {
      if (data.isActive === false) {
        const locations = await tx
          .select({ id: invLocations.id })
          .from(invLocations)
          .where(and(
            eq(invLocations.warehouseId, warehouseId),
            eq(invLocations.orgId, orgId),
          ));

        if (locations.length > 0) {
          const locationIds = locations.map((l) => l.id);
          const [stockRow] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(invStockLevels)
            .where(and(
              inArray(invStockLevels.locationId, locationIds),
              gt(invStockLevels.onHand, "0"),
            ));
          if ((stockRow?.count ?? 0) > 0) {
            throw new ConflictException("Cannot deactivate warehouse with existing stock");
          }
        }
      }

      if (data.isDefault) {
        await tx.update(invWarehouses)
          .set({ isDefault: false })
          .where(eq(invWarehouses.orgId, orgId));
      }

      const [row] = await tx.update(invWarehouses)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)))
        .returning();
      if (!row) throw new NotFoundException("Warehouse not found");
      return row;
    });

    await Promise.all([
      this.cache.invalidateNamespaceForOrg(orgId, "inv:warehouses"),
      this.cache.del(CACHE_KEYS.invWarehouseDetail(orgId, warehouseId)),
    ]);
    return updated;
  }

  // B1-13: Bounded to MAX_PAGE_LIMIT. Accepts optional {page, limit}.
  // Return shape preserved (array) — full {data, pagination} envelope is a follow-up.
  async listLocations(orgId: string, warehouseId: number, page = 1, limit = MAX_PAGE_LIMIT) {
    const boundedLimit = Math.min(limit, MAX_PAGE_LIMIT);
    const offset = (page - 1) * boundedLimit;
    return this.db.query.invLocations.findMany({
      where: and(eq(invLocations.warehouseId, warehouseId), eq(invLocations.orgId, orgId)),
      orderBy: (t, { asc: a }) => [a(t.code)],
      limit: boundedLimit,
      offset,
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
    const wh = await this.db.query.invWarehouses.findFirst({
      where: and(eq(invWarehouses.id, warehouseId), eq(invWarehouses.orgId, orgId)),
      columns: { id: true },
    });
    if (!wh) throw new NotFoundException("Warehouse not found");

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
