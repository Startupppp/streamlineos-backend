import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { invVendors } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { ListVendorsInput, CreateVendorInput, UpdateVendorInput } from "./dto/inv-vendors.schemas";

@Injectable()
export class InvVendorsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listVendors(orgId: string, filters: ListVendorsInput) {
    const { search, isActive, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${search ?? ""}:${isActive ?? ""}:${limit}:${offset}`;

    return this.cache.cached(CACHE_KEYS.invVendorsList(orgId, hash), async () => {
      const conditions = [eq(invVendors.orgId, orgId)];
      if (search) conditions.push(ilike(invVendors.name, `%${search}%`));
      if (isActive !== undefined) conditions.push(eq(invVendors.isActive, isActive));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invVendors.findMany({
          where,
          orderBy: [desc(invVendors.name)],
          limit,
          offset,
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invVendors).where(where),
      ]);

      return {
        items,
        total: countResult[0]?.count ?? 0,
        page,
        totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
      };
    }, CACHE_TTL.SHORT);
  }

  async getVendor(orgId: string, vendorId: number) {
    const vendor = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)),
    });
    if (!vendor) throw new NotFoundException("Vendor not found");
    return vendor;
  }

  async createVendor(orgId: string, userId: string, data: CreateVendorInput) {
    const existing = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.orgId, orgId), eq(invVendors.code, data.code)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A vendor with this code already exists");

    const [vendor] = await this.db.insert(invVendors).values({ orgId, createdBy: userId, ...data }).returning();
    await this.cache.invalidatePattern(`inv:vendors:list:${orgId}:*`);
    return vendor;
  }

  async updateVendor(orgId: string, vendorId: number, data: UpdateVendorInput) {
    const [updated] = await this.db.update(invVendors)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Vendor not found");
    await this.cache.invalidatePattern(`inv:vendors:list:${orgId}:*`);
    return updated;
  }
}
