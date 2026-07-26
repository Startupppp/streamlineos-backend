import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { invQualityHolds, invStockLevels } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { StockEngineService } from "../inv-stock-engine/stock-engine.service";
import { InventoryAuditService } from "../inv-stock-engine/inventory-audit.service";
import type { ListHoldsQueryInput, CreateHoldInput } from "./dto/quality.schemas";

@Injectable()
export class HoldsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string, query: ListHoldsQueryInput) {
    const { status, productVariantId, page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${productVariantId ?? ""}:${limit}:${offset}`;
    return this.cache.cached(
      CACHE_KEYS.invQualityHoldsList(orgId, hash),
      async () => {
        const conditions = [eq(invQualityHolds.orgId, orgId)];
        if (status) conditions.push(eq(invQualityHolds.status, status));
        if (productVariantId) conditions.push(eq(invQualityHolds.productVariantId, productVariantId));
        const where = and(...conditions);
        const [items, countResult] = await Promise.all([
          this.db.query.invQualityHolds.findMany({
            where,
            orderBy: [desc(invQualityHolds.createdAt)],
            limit,
            offset,
            with: {
              productVariant: {
                columns: { name: true, sku: true },
                with: {
                  product: { columns: { name: true } },
                },
              },
            },
          }),
          this.db.select({ count: sql<number>`count(*)::int` }).from(invQualityHolds).where(where),
        ]);
        const enriched = items.map(({ productVariant, ...hold }) => ({
          ...hold,
          variantName: productVariant?.name ?? undefined,
          variantSku: productVariant?.sku ?? undefined,
          productName: productVariant?.product?.name ?? undefined,
        }));
        return { items: enriched, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

  async findOne(orgId: string, holdId: number) {
    return this.cache.cached(
      CACHE_KEYS.invQualityHoldDetail(orgId, holdId),
      async () => {
        const row = await this.db.query.invQualityHolds.findFirst({
          where: and(eq(invQualityHolds.id, holdId), eq(invQualityHolds.orgId, orgId)),
        });
        if (!row) throw new NotFoundException("Not found");
        return row;
      },
      CACHE_TTL.SHORT,
    );
  }

  async create(orgId: string, userId: string, idempotencyKey: string, input: CreateHoldInput) {
    await this.engine.execute(orgId, userId, {
      idempotencyKey,
      sourceType: "QUALITY_HOLD",
      sourceId: String(orgId),
      movements: [
        {
          transactionType: "QUARANTINE_IN",
          productVariantId: input.productVariantId,
          locationId: input.locationId,
          lotId: input.lotId,
          serialId: input.serialId,
          quantityDelta: "-" + input.quantity,
          qualityBucket: "ON_HAND",
        },
        {
          transactionType: "QUARANTINE_IN",
          productVariantId: input.productVariantId,
          locationId: input.locationId,
          lotId: input.lotId,
          serialId: input.serialId,
          quantityDelta: input.quantity,
          qualityBucket: "QUALITY_HOLD",
        },
      ],
    });
    const [hold] = await this.db.insert(invQualityHolds).values({
      orgId,
      productVariantId: input.productVariantId,
      locationId: input.locationId,
      lotId: input.lotId ?? null,
      serialId: input.serialId ?? null,
      quantity: input.quantity,
      reason: input.reason,
      createdBy: userId,
    }).returning();
    await this.audit.insert(this.db, {
      orgId, actorUserId: userId, action: "quality_hold.created",
      resourceType: "quality_hold", resourceId: String(hold?.id ?? 0),
      after: { productVariantId: input.productVariantId, quantity: input.quantity },
    });
    await this.cache.invalidatePattern(`inv:quality:holds:${orgId}:*`);
    return hold;
  }

  async release(orgId: string, userId: string, holdId: number, idempotencyKey: string) {
    const hold = await this.db.query.invQualityHolds.findFirst({
      where: and(eq(invQualityHolds.id, holdId), eq(invQualityHolds.orgId, orgId)),
    });
    if (!hold) throw new NotFoundException("Not found");
    if (hold.status !== "ACTIVE") throw new ConflictException("Invalid state");

    let locationId = hold.locationId;
    if (!locationId) {
      const [level] = await this.db.select({ locationId: invStockLevels.locationId })
        .from(invStockLevels)
        .where(and(
          eq(invStockLevels.orgId, orgId),
          eq(invStockLevels.productVariantId, hold.productVariantId),
        ))
        .limit(1);
      locationId = level?.locationId ?? null;
    }
    if (!locationId) throw new ConflictException("No stock location found for hold");

    await this.engine.execute(orgId, userId, {
      idempotencyKey,
      sourceType: "QUALITY_HOLD_RELEASE",
      sourceId: String(holdId),
      movements: [
        {
          transactionType: "QUARANTINE_OUT",
          productVariantId: hold.productVariantId,
          locationId,
          lotId: hold.lotId ?? undefined,
          serialId: hold.serialId ?? undefined,
          quantityDelta: "-" + hold.quantity,
          qualityBucket: "QUALITY_HOLD",
        },
        {
          transactionType: "QUARANTINE_OUT",
          productVariantId: hold.productVariantId,
          locationId,
          lotId: hold.lotId ?? undefined,
          serialId: hold.serialId ?? undefined,
          quantityDelta: hold.quantity,
          qualityBucket: "ON_HAND",
        },
      ],
    });

    await this.db.update(invQualityHolds)
      .set({ status: "RELEASED", releasedBy: userId, releasedAt: new Date() })
      .where(and(eq(invQualityHolds.id, holdId), eq(invQualityHolds.orgId, orgId)));
    await this.audit.insert(this.db, {
      orgId, actorUserId: userId, action: "quality_hold.released",
      resourceType: "quality_hold", resourceId: String(holdId),
    });
    await this.cache.invalidatePattern(`inv:quality:holds:${orgId}:*`);
    return this.db.query.invQualityHolds.findFirst({
      where: and(eq(invQualityHolds.id, holdId), eq(invQualityHolds.orgId, orgId)),
    });
  }
}
