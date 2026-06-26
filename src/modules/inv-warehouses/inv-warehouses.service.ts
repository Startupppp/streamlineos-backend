import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invWarehouses, invLocations } from "../../db/schema";
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
        orderBy: (t, { asc }) => [asc(t.name)],
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
    await this.cache.del(CACHE_KEYS.invWarehousesList(orgId));
    return wh;
  }

  async updateWarehouse(orgId: string, warehouseId: number, data: UpdateWarehouseInput) {
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
      orderBy: (t, { asc }) => [asc(t.code)],
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
    const [updated] = await this.db.update(invLocations)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invLocations.id, locationId), eq(invLocations.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Location not found");
    return updated;
  }
}
