import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { invVendors, invPurchaseOrders } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
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

    return this.cache.cachedVersioned(CACHE_KEYS.invVendorsNamespace(orgId), hash, async () => {
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

  private async nextVendorCode(orgId: string): Promise<string> {
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(invVendors)
      .where(eq(invVendors.orgId, orgId));
    const cnt = rows[0]?.cnt ?? 0;
    return `VND-${String(cnt + 1).padStart(4, "0")}`;
  }

  async createVendor(orgId: string, userId: string, data: CreateVendorInput) {
    const code = data.code ?? (await this.nextVendorCode(orgId));
    const existing = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.orgId, orgId), eq(invVendors.code, code)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A vendor with this code already exists");

    const [vendor] = await this.db.insert(invVendors).values({ orgId, createdBy: userId, ...data, code }).returning();
    await this.cache.invalidateNamespace(CACHE_KEYS.invVendorsNamespace(orgId));
    return vendor;
  }

  async updateVendor(orgId: string, vendorId: number, data: UpdateVendorInput) {
    if (data.isActive === false) {
      const [openRow] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invPurchaseOrders)
        .where(and(
          eq(invPurchaseOrders.orgId, orgId),
          eq(invPurchaseOrders.vendorId, vendorId),
          inArray(invPurchaseOrders.status, ["DRAFT", "SENT", "PARTIAL"])
        ));
      if ((openRow?.count ?? 0) > 0) {
        throw new ConflictException("Cannot deactivate vendor with open purchase orders");
      }
    }

    const [updated] = await this.db.update(invVendors)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Vendor not found");
    await this.cache.invalidateNamespace(CACHE_KEYS.invVendorsNamespace(orgId));
    return updated;
  }
}
