import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  invQualityInspections,
  invQualityInspectionLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import type { StockMovement } from "../stock-engine/stock-engine.types";
import { batchFetchStockLevels, disposeInspection, stockLevelKey } from "./quality-disposition";
import type {
  ListInspectionsQueryInput,
  CreateInspectionInput,
  FailInspectionInput,
  DisposeInspectionInput,
} from "./dto/quality.schemas";

@Injectable()
export class InspectionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
  ) {}

  async list(orgId: string, query: ListInspectionsQueryInput) {
    const { status, sourceType, productVariantId, page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${sourceType ?? ""}:${productVariantId ?? ""}:${limit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invQualityInspectionsNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invQualityInspections.orgId, orgId)];
        if (status) conditions.push(eq(invQualityInspections.status, status));
        if (sourceType) conditions.push(eq(invQualityInspections.sourceType, sourceType));
        if (productVariantId) {
          const subIds = await this.db
            .select({ id: invQualityInspectionLines.inspectionId })
            .from(invQualityInspectionLines)
            .where(eq(invQualityInspectionLines.productVariantId, productVariantId));
          conditions.push(inArray(invQualityInspections.id, subIds.map(r => r.id)));
        }
        const where = and(...conditions);
        const [items, countResult] = await Promise.all([
          this.db.query.invQualityInspections.findMany({
            where,
            orderBy: [desc(invQualityInspections.createdAt)],
            limit,
            offset,
            with: { lines: true },
          }),
          this.db.select({ count: sql<number>`count(*)::int` }).from(invQualityInspections).where(where),
        ]);
        return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
      },
      CACHE_TTL.SHORT,
    );
  }

  async findOne(orgId: string, id: number) {
    const row = await this.db.query.invQualityInspections.findFirst({
      where: and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)),
      with: { lines: true },
    });
    if (!row) throw new NotFoundException("Not found");
    return row;
  }

  async create(orgId: string, userId: string, input: CreateInspectionInput) {
    const result = await this.db.transaction(async (tx) => {
      const inspectionNumber = await this.numSeq.next(orgId, "INSPECTION", tx);
      const [ins] = await tx.insert(invQualityInspections).values({
        orgId,
        inspectionNumber,
        sourceType: input.sourceType ?? "MANUAL",
        sourceId: input.sourceId ?? "0",
        inspectorUserId: input.inspectorUserId ?? null,
        notes: input.notes ?? null,
        createdBy: userId,
      }).returning();
      if (!ins) throw new BadRequestException("Insert failed");
      const lines = await tx.insert(invQualityInspectionLines).values(
        input.lines.map(l => ({
          inspectionId: ins.id,
          productVariantId: l.productVariantId,
          lotId: l.lotId ?? null,
          serialId: l.serialId ?? null,
          quantity: l.quantity,
          notes: l.notes ?? null,
        })),
      ).returning();
      await this.audit.insert(tx, {
        orgId, actorUserId: userId, action: "quality_inspection.created",
        resourceType: "inspection", resourceId: String(ins.id),
        after: { inspectionNumber, linesCount: lines.length },
      });
      return { ...ins, lines };
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId));
    return result;
  }

  async start(orgId: string, userId: string, id: number) {
    const inspection = await this.findOne(orgId, id);
    if (inspection.status !== "PENDING") throw new ConflictException("Invalid state");
    await this.db.update(invQualityInspections)
      .set({ status: "IN_PROGRESS" })
      .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
    await this.audit.insert(this.db, {
      orgId, actorUserId: userId, action: "quality_inspection.started",
      resourceType: "inspection", resourceId: String(id),
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId));
    return this.findOne(orgId, id);
  }

  async pass(orgId: string, userId: string, id: number, idempotencyKey: string) {
    const inspection = await this.findOne(orgId, id);
    if (inspection.status !== "IN_PROGRESS" && inspection.status !== "PASSED") {
      throw new ConflictException("Invalid state");
    }
    const movements: StockMovement[] = [];
    const stockLevelMap = await batchFetchStockLevels(this.db, orgId, inspection.lines);
    for (const line of inspection.lines) {
      const levelKey = stockLevelKey(line.productVariantId, line.lotId, line.serialId);
      const level = stockLevelMap.get(levelKey);
      if (level && parseFloat(level.qualityHoldQty ?? "0") > 0) {
        movements.push(
          { transactionType: "QUARANTINE_OUT", productVariantId: line.productVariantId, locationId: level.locationId, lotId: line.lotId ?? undefined, serialId: line.serialId ?? undefined, quantityDelta: "-" + line.quantity, qualityBucket: "QUALITY_HOLD" },
          { transactionType: "ADJUSTMENT_IN", productVariantId: line.productVariantId, locationId: level.locationId, lotId: line.lotId ?? undefined, serialId: line.serialId ?? undefined, quantityDelta: line.quantity, qualityBucket: "ON_HAND" },
        );
      }
    }
    if (movements.length > 0) {
      await this.engine.execute(orgId, userId, { idempotencyKey, sourceType: "INSPECTION", sourceId: String(id), movements });
    }
    await this.db.update(invQualityInspections)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
    await this.audit.insert(this.db, {
      orgId, actorUserId: userId, action: "quality_inspection.passed",
      resourceType: "inspection", resourceId: String(id),
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId));
    return this.findOne(orgId, id);
  }

  async fail(orgId: string, userId: string, id: number, input: FailInspectionInput) {
    const inspection = await this.findOne(orgId, id);
    if (inspection.status !== "IN_PROGRESS") throw new ConflictException("Invalid state");
    await this.db.transaction(async (tx) => {
      for (const fl of input.lines) {
        await tx.update(invQualityInspectionLines)
          .set({ disposition: fl.disposition, notes: fl.notes ?? null })
          .where(and(eq(invQualityInspectionLines.id, fl.lineId), eq(invQualityInspectionLines.inspectionId, id)));
      }
      await tx.update(invQualityInspections)
        .set({ status: "DISPOSITION_REQUIRED" })
        .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
      await this.audit.insert(tx, {
        orgId, actorUserId: userId, action: "quality_inspection.failed",
        resourceType: "inspection", resourceId: String(id),
      });
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId));
    return this.findOne(orgId, id);
  }

  async dispose(orgId: string, userId: string, id: number, input: DisposeInspectionInput, idempotencyKey: string) {
    const inspection = await this.findOne(orgId, id);
    if (inspection.status !== "DISPOSITION_REQUIRED") throw new ConflictException("Invalid state");
    await disposeInspection(
      { db: this.db, cache: this.cache, engine: this.engine, numSeq: this.numSeq, audit: this.audit },
      orgId,
      userId,
      id,
      inspection.lines,
      input,
      idempotencyKey,
    );
    return this.findOne(orgId, id);
  }

  async cancel(orgId: string, userId: string, id: number) {
    const inspection = await this.findOne(orgId, id);
    if (inspection.status !== "PENDING" && inspection.status !== "IN_PROGRESS") {
      throw new ConflictException("Invalid state");
    }
    await this.db.update(invQualityInspections)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
    await this.audit.insert(this.db, {
      orgId, actorUserId: userId, action: "quality_inspection.cancelled",
      resourceType: "inspection", resourceId: String(id),
    });
    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId));
    return this.findOne(orgId, id);
  }
}
