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
import { StockEngineBatchService } from "../stock-engine/stock-engine-batch.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { ListRecallsQueryInput, CreateRecallInput, UpdateRecallInput } from "./dto/quality.schemas";

@Injectable()
export class RecallsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineBatchService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string, query: ListRecallsQueryInput) {
    const { status, page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${limit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invQualityRecallsNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invRecallEvents.orgId, orgId)];
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

  async create(orgId: string, userId: string, input: CreateRecallInput) {
    const { recall, lines } = await this.db.transaction(async (tx) => {
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
    });

    const lotIds = lines
      .map(l => l.lotId)
      .filter((lotId): lotId is number => lotId !== null && lotId !== undefined);

    if (lotIds.length > 0) {
      const allStockLevels = await this.db.select().from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), inArray(invStockLevels.lotId, lotIds)));

      const eligibleLevels = allStockLevels.filter(level => parseFloat(level.onHand) > 0);

      const recallCommands = eligibleLevels.flatMap(level => {
        const lotId = level.lotId;
        if (lotId === null || lotId === undefined) return [];
        const iKey = `recall:${recall.id}:lot:${lotId}:loc:${level.locationId}`;
        return [{
          idempotencyKey: iKey,
          sourceType: "RECALL",
          sourceId: String(recall.id),
          movements: [
            { transactionType: "QUARANTINE_IN", productVariantId: level.productVariantId, locationId: level.locationId, lotId, quantityDelta: "-" + level.onHand, qualityBucket: "ON_HAND" as const },
            { transactionType: "QUARANTINE_IN", productVariantId: level.productVariantId, locationId: level.locationId, lotId, quantityDelta: level.onHand, qualityBucket: "QUALITY_HOLD" as const },
          ],
        }];
      });

      if (recallCommands.length > 0) {
        await this.engine.executeMany(orgId, userId, recallCommands);
      }

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
