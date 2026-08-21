import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { invCycleCounts, invCycleCountLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import type { ListCountsInput, CreateCycleCountInput, UpdateCountLinesInput } from "./dto/inv-counts.schemas";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";

@Injectable()
export class InvCycleCountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
  ) {}

  async listCycleCounts(orgId: string, userId: string, filters: ListCountsInput) {
    const { status, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const scopeKey = scope === null ? "all" : ([...scope].sort((a, b) => a - b).join(".") || "none");
    const hash = `${scopeKey}:${status ?? ""}:${warehouseId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invCycleCountsNamespace(orgId), hash, async () => {
      const conditions = [eq(invCycleCounts.orgId, orgId)];
      conditions.push(this.warehouseScope.warehousePredicate(scope, sql`${invCycleCounts.warehouseId}`));
      if (status) conditions.push(eq(invCycleCounts.status, status));
      if (warehouseId) conditions.push(eq(invCycleCounts.warehouseId, warehouseId));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invCycleCounts.findMany({
          where,
          orderBy: [desc(invCycleCounts.createdAt)],
          limit,
          offset,
          with: { creator: { columns: { id: true, name: true } } },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invCycleCounts).where(where),
      ]);

      const total = countResult[0]?.count ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  async getCycleCount(orgId: string, countId: number) {
    const cc = await this.db.query.invCycleCounts.findFirst({
      where: and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)),
      with: {
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            location: { columns: { id: true, name: true, code: true } },
          },
        },
      },
    });
    if (!cc) throw new NotFoundException("Cycle count not found");
    return cc;
  }

  async createCycleCount(orgId: string, userId: string, data: CreateCycleCountInput) {
    const countNumber = await this.numSeq.next(orgId, "CYCLE_COUNT");

    const [cc] = await this.db.insert(invCycleCounts).values({
      orgId,
      countNumber,
      warehouseId: data.warehouseId,
      locationId: data.locationId ?? null,
      categoryId: data.categoryId ?? null,
      status: "PLANNED",
      createdBy: userId,
    }).returning();

    const stockLevels = await this.db.execute<{
      product_variant_id: number; location_id: number; lot_id: number | null; on_hand: string;
    }>(sql`
      SELECT sl.product_variant_id, sl.location_id, sl.lot_id, sl.on_hand
      FROM inv_stock_levels sl
      JOIN inv_locations loc ON loc.id = sl.location_id
      WHERE sl.org_id = ${orgId} AND loc.warehouse_id = ${data.warehouseId}
      ${data.locationId ? sql`AND sl.location_id = ${data.locationId}` : sql``}
      ${data.categoryId
        ? sql`AND sl.product_variant_id IN (SELECT id FROM inv_product_variants WHERE product_id IN (SELECT id FROM inv_products WHERE category_id = ${data.categoryId} AND org_id = ${orgId}))`
        : sql``
      }
    `);

    if (stockLevels.length > 0) {
      await this.db.insert(invCycleCountLines).values(
        stockLevels.map((row) => ({
          cycleCountId: cc.id,
          productVariantId: row.product_variant_id,
          locationId: row.location_id,
          lotId: row.lot_id ?? null,
          systemQty: row.on_hand,
        }))
      );
    }

    await this.cache.invalidateNamespace(CACHE_KEYS.invCycleCountsNamespace(orgId));
    return this.getCycleCount(orgId, cc.id);
  }

  async startCycleCount(orgId: string, countId: number) {
    const cc = await this.requireCount(orgId, countId);
    if (cc.status !== "PLANNED") throw new BadRequestException("Only PLANNED counts can be started");

    await this.db.update(invCycleCounts)
      .set({ status: "COUNTING" })
      .where(and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)));

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
    return this.getCycleCount(orgId, countId);
  }

  async updateLines(orgId: string, countId: number, data: UpdateCountLinesInput) {
    const cc = await this.requireCount(orgId, countId);
    if (cc.status !== "COUNTING") throw new BadRequestException("Lines can only be updated while status is COUNTING");

    if (data.lines.length > 0) {
      const values = sql.join(
        data.lines.map(
          (update) => sql`(${update.lineId}, ${update.countedQty.toFixed(4)}::numeric)`,
        ),
        sql`, `,
      );
      await this.db.execute(sql`
        UPDATE ${invCycleCountLines}
        SET counted_qty = updates.counted_qty
        FROM (VALUES ${values}) AS updates(id, counted_qty)
        WHERE ${invCycleCountLines.id} = updates.id
          AND ${invCycleCountLines.cycleCountId} = ${countId}
      `);
    }

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
    return this.getCycleCount(orgId, countId);
  }

  async reviewCycleCount(orgId: string, countId: number) {
    const cc = await this.requireCount(orgId, countId);
    if (cc.status !== "COUNTING") throw new BadRequestException("Only COUNTING counts can move to REVIEW");

    await this.db
      .update(invCycleCountLines)
      .set({
        varianceQty: sql`coalesce(${invCycleCountLines.countedQty}, 0) - ${invCycleCountLines.systemQty}`,
      })
      .where(eq(invCycleCountLines.cycleCountId, countId));

    await this.db.update(invCycleCounts)
      .set({ status: "REVIEW" })
      .where(and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)));

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
    return this.getCycleCount(orgId, countId);
  }

  async postCycleCount(orgId: string, userId: string, countId: number, idempotencyKey: string) {
    const cc = await this.requireCount(orgId, countId);
    if (cc.status !== "REVIEW") throw new BadRequestException("Only REVIEW counts can be posted");

    const lines = await this.db.query.invCycleCountLines.findMany({
      where: eq(invCycleCountLines.cycleCountId, countId),
      columns: { productVariantId: true, locationId: true, varianceQty: true },
    });

    const movements = lines
      .filter((l) => l.varianceQty !== null && parseFloat(l.varianceQty) !== 0)
      .map((l) => {
        const v = parseFloat(l.varianceQty!);
        return {
          transactionType: v > 0 ? "CYCLE_COUNT_GAIN" as const : "CYCLE_COUNT_LOSS" as const,
          productVariantId: l.productVariantId,
          locationId: l.locationId,
          quantityDelta: v.toFixed(4),
        };
      });

    await this.db.transaction(async (tx) => {
      if (movements.length > 0) {
        await this.engine.executeInTx(tx, orgId, userId, {
          idempotencyKey,
          sourceType: "inv_cycle_count",
          sourceId: countId.toString(),
          reason: `Cycle count ${cc.countNumber}`,
          movements,
        });
      }

      await tx.update(invCycleCounts)
        .set({ status: "POSTED", postedAt: new Date(), approvedBy: userId })
        .where(and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)));
    });

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invCycleCountsNamespace(orgId));
    return this.getCycleCount(orgId, countId);
  }

  async cancelCycleCount(orgId: string, countId: number) {
    const cc = await this.requireCount(orgId, countId);
    if (cc.status === "POSTED") throw new BadRequestException("Posted counts cannot be cancelled");

    await this.db.update(invCycleCounts)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)));

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
  }

  private async requireCount(orgId: string, countId: number) {
    const cc = await this.db.query.invCycleCounts.findFirst({
      where: and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)),
      columns: { id: true, status: true, countNumber: true },
    });
    if (!cc) throw new NotFoundException("Cycle count not found");
    return cc;
  }
}
