import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  invRecallEvents,
  invRecallLines,
  invLots,
  invStockLevels,
  invQualityHolds,
  invShipments,
  invShipmentLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ListRecallsQueryInput, CreateRecallInput, UpdateRecallInput } from "./dto/quality.schemas";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { isPositive } from "../stock-engine/decimal";
import { runIdempotent } from "../stock-engine/idempotency";

/**
 * A replayed recall, rebuilt from the stored JSON. Only the identity is revived:
 * a replay says "this recall already exists", and the caller re-reads it if it
 * needs the rest.
 */
function reviveRecall(stored: unknown): {
  recall: { id: number; recallNumber: string };
  lines: Array<{ lotId: number | null }>;
} {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const recall = typeof row.recall === "object" && row.recall !== null
    ? (row.recall as Record<string, unknown>)
    : {};
  const lines = Array.isArray(row.lines) ? row.lines : [];
  return {
    recall: { id: Number(recall.id ?? 0), recallNumber: String(recall.recallNumber ?? "") },
    lines: lines.map((l) => {
      const line = typeof l === "object" && l !== null ? (l as Record<string, unknown>) : {};
      return { lotId: line.lotId == null ? null : Number(line.lotId) };
    }),
  };
}

@Injectable()
export class RecallsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string, userId: string, query: ListRecallsQueryInput) {
    const { status, page, limit } = query;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.resolve(orgId, userId);
    // The resolved scope belongs in the key. Without it the first caller's
    // warehouses are cached and served to the next, which defeats the
    // predicate in both directions.
    const scopeKey =
      scope === null ? "all" : ([...scope].sort((a, b) => a - b).join(".") || "none");
    const hash = `${scopeKey}:${status ?? ""}:${limit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invQualityRecallsNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invRecallEvents.orgId, orgId)];

        // INV-109. A recall carries no warehouse of its own; it is attributable
        // through the lots and variants its lines name, and those through the
        // stock they hold. A recall touching nothing an operator can see stays
        // out of their list.
        //
        // Hiding a safety event reads uncomfortably, so worth being explicit:
        // visibility is not what stops recalled goods moving. The allocator
        // refuses a recalled lot under every strategy regardless of who is
        // looking, so scoping the list changes what an operator reads, never
        // what the engine permits.
        if (scope !== null) {
          conditions.push(
            sql`EXISTS (
              SELECT 1
              FROM inv_recall_lines rl
              JOIN inv_stock_levels sl
                ON sl.org_id = rl.org_id
               AND (sl.lot_id = rl.lot_id
                    OR (rl.lot_id IS NULL AND sl.product_variant_id = rl.product_variant_id))
              WHERE rl.org_id = ${orgId}
                AND rl.recall_id = ${invRecallEvents.id}
                AND ${this.warehouseScope.locationPredicate(scope, sql`sl.location_id`)}
            )`,
          );
        }

        if (status) conditions.push(eq(invRecallEvents.status, status));
        const where = and(...conditions);
        const [items, countResult] = await Promise.all([
          this.db.query.invRecallEvents.findMany({
            where,
            orderBy: [desc(invRecallEvents.createdAt)],
            limit,
            offset,
            with: { lines: true },
          }),
          this.db.select({ count: sql<number>`count(*)::int` }).from(invRecallEvents).where(where),
        ]);
        return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

  async findOne(orgId: string, id: number) {
    const recall = await this.db.query.invRecallEvents.findFirst({
      where: and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId)),
      with: { lines: true },
    });
    if (!recall) throw new NotFoundException("Not found");

    const lotIds = recall.lines
      .map(l => l.lotId)
      .filter((lotId): lotId is number => lotId !== null && lotId !== undefined);
    const serialIds = recall.lines
      .map(l => l.serialId)
      .filter((sid): sid is number => sid !== null && sid !== undefined);

    let affectedShipments: Array<{ shipmentId: number; shipmentNumber: string }> = [];
    if (lotIds.length > 0 || serialIds.length > 0) {
      const lineConditions = [];
      if (lotIds.length > 0) lineConditions.push(inArray(invShipmentLines.lotId, lotIds));
      if (serialIds.length > 0) lineConditions.push(inArray(invShipmentLines.serialId, serialIds));
      const results = await this.db
        .select({ shipmentId: invShipments.id, shipmentNumber: invShipments.shipmentNumber })
        .from(invShipmentLines)
        .innerJoin(invShipments, and(eq(invShipmentLines.shipmentId, invShipments.id), eq(invShipments.orgId, orgId)))
        .where(or(...lineConditions));
      affectedShipments = results;
    }

    return { ...recall, affectedShipments };
  }

  async create(orgId: string, userId: string, input: CreateRecallInput, idempotencyKey: string) {
    // A3/A5. The engine claims a derived key per lot, so the quarantine
    // movements were already replay-safe — but the recall *document* was not,
    // so a retried request raised a second recall with a second number against
    // the same lots.
    const { recall, lines } = await this.db.transaction(async (tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quality.recall.create", input },
        async () => {
      const recallNumber = await this.numSeq.next(orgId, "RECALL", tx);
      const [recall] = await tx.insert(invRecallEvents).values({
        orgId,
        recallNumber,
        title: input.title,
        description: input.description ?? null,
        createdBy: userId,
      }).returning();
      if (!recall) throw new Error("Insert recall failed");
      const lines = await tx.insert(invRecallLines).values(
        input.lines.map(l => ({
          orgId,
          recallId: recall.id,
          productVariantId: l.productVariantId ?? null,
          lotId: l.lotId ?? null,
          serialId: l.serialId ?? null,
        })),
      ).returning();
      const recalledLotIds = lines
        .map(l => l.lotId)
        .filter((id): id is number => id !== null && id !== undefined);
      if (recalledLotIds.length > 0) {
        await tx.update(invLots)
          .set({ status: "RECALLED" })
          .where(and(inArray(invLots.id, recalledLotIds), eq(invLots.orgId, orgId)));
      }
      await this.audit.insert(tx, {
        orgId, actorUserId: userId, action: "recall.created",
        resourceType: "recall", resourceId: String(recall.id),
        after: { recallNumber, linesCount: lines.length },
      });
      return { recall, lines };
        },
        (stored) => reviveRecall(stored),
      ),
    );

    const lotIds = lines
      .map(l => l.lotId)
      .filter((lotId): lotId is number => lotId !== null && lotId !== undefined);

    if (lotIds.length > 0) {
      // Projected, not `select()`: an unprojected read here returned every
      // column of every matching stock row, and `parseFloat` on an 18,4 numeric
      // is the float arithmetic the ledger rules forbid — a lot holding
      // 0.0001 units is on the shelf and must be recalled with the rest.
      const allStockLevels = await this.db
        .select({
          productVariantId: invStockLevels.productVariantId,
          locationId: invStockLevels.locationId,
          lotId: invStockLevels.lotId,
          onHand: invStockLevels.onHand,
        })
        .from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), inArray(invStockLevels.lotId, lotIds)));

      const eligibleLevels = allStockLevels.filter((level) => isPositive(level.onHand));

      const recallCommands = eligibleLevels.flatMap(level => {
        const lotId = level.lotId;
        if (lotId === null || lotId === undefined) return [];
        const iKey = `recall:${recall.id}:lot:${lotId}:loc:${level.locationId}`;
        return [{
          idempotencyKey: iKey,
          sourceType: "RECALL",
          sourceId: String(recall.id),
          // A recall quarantines the goods; it does not make them disappear.
          // Zeroing ON_HAND as well drove available negative and destroyed the
          // count of what is physically on the shelf — which is exactly the
          // number a recall needs to report.
          movements: [
            { transactionType: "QUARANTINE_IN", productVariantId: level.productVariantId, locationId: level.locationId, lotId, quantityDelta: level.onHand, qualityBucket: "QUALITY_HOLD" as const },
          ],
        }];
      });

      if (recallCommands.length > 0) {
        await this.engine.executeMany(orgId, userId, recallCommands);
      }

      // Inside the same transaction as the quarantine movements: the hold
      // document and the stock it describes have to commit together, or a
      // rolled-back recall leaves holds against stock nothing quarantined.
      if (eligibleLevels.length > 0) {
        await this.db.insert(invQualityHolds).values(
          eligibleLevels.map(level => ({
            orgId,
            productVariantId: level.productVariantId,
            locationId: level.locationId,
            lotId: level.lotId,
            quantity: level.onHand,
            reason: `Recall ${recall.recallNumber}`,
            createdBy: userId,
          })),
        );
      }
    }

    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityRecallsNamespace(orgId));
    return recall;
  }

  async update(orgId: string, userId: string, id: number, input: UpdateRecallInput) {
    const recall = await this.db.query.invRecallEvents.findFirst({
      where: and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId)),
    });
    if (!recall) throw new NotFoundException("Not found");
    const patch: Partial<typeof invRecallEvents.$inferInsert> = {};
    if (input.status) {
      patch.status = input.status;
      if (input.status === "CLOSED") patch.closedAt = new Date();
    }
    await this.db.update(invRecallEvents).set(patch)
      .where(and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId)));
    await this.audit.insert(this.db, {
      orgId, actorUserId: userId, action: "recall.updated",
      resourceType: "recall", resourceId: String(id),
      before: { status: recall.status }, after: patch,
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityRecallsNamespace(orgId));
    return this.db.query.invRecallEvents.findFirst({
      where: and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId)),
      with: { lines: true },
    });
  }
}
