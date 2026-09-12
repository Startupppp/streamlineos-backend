import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { invCycleCounts, invCycleCountLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { StockMovementBridgeService } from "../../accounting/adapters/stock-movement-bridge.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { buildCountVarianceMovements } from "./count-variance-movements";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
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
    private readonly glBridge: StockMovementBridgeService,
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

  /**
   * One cycle count, behind the SAME warehouse scope `listCycleCounts` applies.
   *
   * It took no caller id at all — the controller has `@CurrentUser()` in hand
   * and passed only `u.orgId` — so it answered on `org_id` and the row id alone
   * while the list directly above it resolves the caller's warehouses and gates
   * on them. Whoever could not see a count in the list could still read it
   * whole by id: header, every line, every counted and system quantity.
   *
   * NULL WAREHOUSE — EXCLUDED, following this table's own aggregate rather than
   * a house default. `listCycleCounts` gates through `warehousePredicate`, which
   * renders `warehouse_id IN (...)` with no `IS NULL` arm, so an unattributed
   * count is invisible in the list and is invisible here too. That is the
   * labour-records rule, not the ASN one — the ASN list deliberately keeps
   * unattributed rows and its detail had to match. `inv_cycle_counts.warehouse_id`
   * is `NOT NULL` today so the case cannot arise; the rule is written down so
   * that making it nullable later does not silently pick the other answer.
   *
   * Out of scope answers 404, the same as a missing row (§4), so this is not an
   * oracle for which counts exist. An empty scope compiles to `FALSE` in the
   * WHERE — exactly what the list does with it — rather than an early return.
   */
  async getCycleCount(orgId: string, userId: string, countId: number) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return this.loadCycleCount(orgId, countId, [
      this.warehouseScope.warehousePredicate(scope, sql`${invCycleCounts.warehouseId}`),
    ]);
  }

  /**
   * The unscoped read, named so nobody routes to it by accident.
   *
   * `createCycleCount` ends by returning the row it has just written, and the
   * writer is entitled to see what they wrote — gating that path would 404 a
   * creator against their own new count. Every other caller has already passed
   * `requireCount` for this same id, so re-gating there would only resolve the
   * scope a second time. A separate NAMED private method rather than a boolean
   * flag on the public one, so a future route cannot be pointed at it.
   */
  private async loadCycleCountUnscoped(orgId: string, countId: number) {
    return this.loadCycleCount(orgId, countId, []);
  }

  private async loadCycleCount(orgId: string, countId: number, scoped: SQL[]) {
    const cc = await this.db.query.invCycleCounts.findFirst({
      where: and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId), ...scoped),
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
    // The warehouse arrives in the body, so it is the caller's claim and not
    // something already checked. Without this a planner scoped to one building
    // could open a count in another and have every stock level in it copied
    // into the count lines and handed back — the same disclosure the detail
    // read above was giving away, through the create. `createWave` puts this
    // exact gate on its own `input.warehouseId`.
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);

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
          orgId,
          cycleCountId: cc.id,
          productVariantId: row.product_variant_id,
          locationId: row.location_id,
          lotId: row.lot_id ?? null,
          systemQty: row.on_hand,
        }))
      );
    }

    await this.cache.invalidateNamespace(CACHE_KEYS.invCycleCountsNamespace(orgId));
    return this.loadCycleCountUnscoped(orgId, cc.id);
  }

  async startCycleCount(orgId: string, userId: string, countId: number) {
    const cc = await this.requireCount(orgId, userId, countId);
    if (cc.status !== "PLANNED") throw new BadRequestException("Only PLANNED counts can be started");

    await this.db.update(invCycleCounts)
      .set({ status: "COUNTING" })
      .where(and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)));

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
    return this.loadCycleCountUnscoped(orgId, countId);
  }

  async updateLines(orgId: string, userId: string, countId: number, data: UpdateCountLinesInput) {
    const cc = await this.requireCount(orgId, userId, countId);
    if (cc.status !== "COUNTING") throw new BadRequestException("Lines can only be updated while status is COUNTING");

    if (data.lines.length > 0) {
      // The id is cast as deliberately as the quantity. A bound parameter in a
      // `VALUES` list arrives untyped, so Postgres reads it as `text` and the
      // join below dies on `operator does not exist: integer = text` — which
      // means recording a counted quantity has never once worked. Found by the
      // A5 count-event probe, which is the first caller this path has had.
      const values = sql.join(
        data.lines.map(
          (update) => sql`(${update.lineId}::int, ${update.countedQty.toFixed(4)}::numeric)`,
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
    return this.loadCycleCountUnscoped(orgId, countId);
  }

  async reviewCycleCount(orgId: string, userId: string, countId: number) {
    const cc = await this.requireCount(orgId, userId, countId);
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
    return this.loadCycleCountUnscoped(orgId, countId);
  }

  async postCycleCount(orgId: string, userId: string, countId: number, idempotencyKey: string) {
    const cc = await this.requireCount(orgId, userId, countId);
    if (cc.status !== "REVIEW") throw new BadRequestException("Only REVIEW counts can be posted");

    // `lotId` is selected because the count was TAKEN at lot grain — the line
    // carries the lot its `systemQty` was read from. Posting the variance
    // without it moves a different stock level than the one counted: the lot
    // stays wrong for good and a phantom lot-less row absorbs the correction.
    const lines = await this.db.query.invCycleCountLines.findMany({
      where: eq(invCycleCountLines.cycleCountId, countId),
      columns: { productVariantId: true, locationId: true, lotId: true, varianceQty: true },
    });

    const movements = buildCountVarianceMovements(lines);

    await this.db.transaction(async (tx) => {
      if (movements.length > 0) {
        const moved = await this.engine.executeInTx(tx, orgId, userId, {
          idempotencyKey,
          sourceType: "inv_cycle_count",
          sourceId: countId.toString(),
          reason: `Cycle count ${cc.countNumber}`,
          movements,
        });

        // ACC-21. A count variance is stock found or lost, which is a real
        // gain or loss the period has to carry. Posted on this transaction so
        // a locked period refuses the count rather than silently diverging.
        await this.glBridge.post(
          orgId,
          userId,
          {
            kind: "cycle_count",
            documentId: String(countId),
            transactionIds: moved.transactionIds,
            journalDate: new Date().toISOString().slice(0, 10),
            memo: `Cycle count ${cc.countNumber}`,
          },
          tx,
        );
      }

      const posted = await tx.update(invCycleCounts)
        .set({ status: "POSTED", postedAt: new Date(), approvedBy: userId })
        .where(and(
          eq(invCycleCounts.orgId, orgId),
          eq(invCycleCounts.id, countId),
          // Compare-and-set on the status read before the transaction, so a
          // second poster of the same count changes nothing and says nothing.
          eq(invCycleCounts.status, "REVIEW"),
        ))
        .returning({ id: invCycleCounts.id });

      if (posted.length === 0) return;

      // A5. One event for both kinds of count, discriminated by `countType`:
      // a cycle count and a wall-to-wall audit are the same fact to anyone
      // downstream — the books were corrected against a physical count.
      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.COUNT_POSTED,
        aggregateType: "inv_cycle_count",
        aggregateId: String(countId),
        actorUserId: userId,
        payload: {
          countType: "CYCLE",
          countId,
          countNumber: cc.countNumber,
          warehouseId: cc.warehouseId,
          lineCount: lines.length,
          // A count that found nothing is the normal outcome and still a fact
          // worth publishing; the variance count is how a consumer tells the
          // two apart without re-reading every line.
          varianceLineCount: movements.length,
          idempotencyKey,
        },
      });
    });

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invCycleCountsNamespace(orgId));
    return this.loadCycleCountUnscoped(orgId, countId);
  }

  async cancelCycleCount(orgId: string, userId: string, countId: number) {
    const cc = await this.requireCount(orgId, userId, countId);
    if (cc.status === "POSTED") throw new BadRequestException("Posted counts cannot be cancelled");

    await this.db.update(invCycleCounts)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(invCycleCounts.orgId, orgId), eq(invCycleCounts.id, countId)));

    await this.cache.invalidate(CACHE_KEYS.invCycleCountDetail(orgId, countId));
  }

  /**
   * The gate every mutation funnels through, now carrying the caller.
   *
   * `start`, `updateLines`, `review`, `post` and `cancel` all reach the row
   * through here and not one of them took a caller id, so a supervisor scoped
   * to one building could start, rewrite every variance on, post or cancel a
   * count in another. Same predicate as `listCycleCounts` (see `getCycleCount`
   * for the NULL-warehouse rule and why it is this one), and the same 404 for
   * out of scope — a 403 would confirm the count exists.
   */
  private async requireCount(orgId: string, userId: string, countId: number) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const cc = await this.db.query.invCycleCounts.findFirst({
      where: and(
        eq(invCycleCounts.orgId, orgId),
        eq(invCycleCounts.id, countId),
        this.warehouseScope.warehousePredicate(scope, sql`${invCycleCounts.warehouseId}`),
      ),
      columns: { id: true, status: true, countNumber: true, warehouseId: true },
    });
    if (!cc) throw new NotFoundException("Cycle count not found");
    return cc;
  }
}
