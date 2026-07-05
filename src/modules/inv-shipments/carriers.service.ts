import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invCarriers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { InventoryAuditService } from "../inv-stock-engine/inventory-audit.service";
import type { CreateCarrierInput, UpdateCarrierInput } from "./dto/shipments.schemas";

@Injectable()
export class CarriersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
  ) {}

  list(orgId: string) {
    return this.cache.cached(
      CACHE_KEYS.invCarriersList(orgId),
      () => this.db.select().from(invCarriers).where(eq(invCarriers.orgId, orgId)).orderBy(invCarriers.name),
      CACHE_TTL.MEDIUM,
    );
  }

  async create(orgId: string, userId: string, input: CreateCarrierInput) {
    const [carrier] = await this.db.transaction(async (tx) => {
      const rows = await tx.insert(invCarriers).values({ ...input, orgId }).returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "carrier.created",
        resourceType: "carrier",
        resourceId: String(rows[0]!.id),
      });
      return rows;
    });
    await this.cache.invalidate(CACHE_KEYS.invCarriersList(orgId));
    return carrier;
  }

  async update(orgId: string, userId: string, carrierId: number, input: UpdateCarrierInput) {
    const [existing] = await this.db
      .select()
      .from(invCarriers)
      .where(and(eq(invCarriers.id, carrierId), eq(invCarriers.orgId, orgId)))
      .limit(1);
    if (!existing) throw new NotFoundException("Carrier not found");

    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(invCarriers)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(invCarriers.id, carrierId), eq(invCarriers.orgId, orgId)))
        .returning();
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "carrier.updated",
        resourceType: "carrier",
        resourceId: String(carrierId),
        before: existing,
        after: rows[0],
      });
      return rows;
    });
    await this.cache.invalidate(CACHE_KEYS.invCarriersList(orgId));
    return updated;
  }
}
