import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../../common/db/postgres-error";
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
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import type { StockMovement } from "../stock-engine/stock-engine.types";
import {
  dispositionMovements,
  locateLines,
  raiseVendorReturns,
  releaseMovements,
} from "./inspection-release";
import type {
  ListInspectionsQueryInput,
  CreateInspectionInput,
  FailInspectionInput,
  DisposeInspectionInput,
} from "./dto/quality.schemas";
import type { CorrectInspectionInput } from "./dto/inspection-plans.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A verdict has been recorded; the document is evidence from here on. */
const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED"] as const;

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
          orgId,
          inspectionId: ins.id,
          productVariantId: l.productVariantId,
          locationId: l.locationId ?? null,
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

  /**
   * D3. The verdict, the release and the status flip in one claimed transaction.
   *
   * They were three independent writes over two transactions: the engine released
   * the hold, then the status was flipped, then the audit row was written. A
   * crash between the first and the second left the goods released and the
   * inspection still IN_PROGRESS — and the retry that followed tried to release a
   * hold that was already gone, which the engine correctly refuses
   * (`RELEASE_EXCEEDS_HELD`). The claim now spans the whole command, so a retry
   * replays the inspection id and moves nothing.
   */
  async pass(orgId: string, userId: string, id: number, idempotencyKey: string) {
    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quality.inspection.pass", inspectionId: id },
        async () => {
          const inspection = await this.loadForVerdict(tx, orgId, id);
          if (inspection.status !== "IN_PROGRESS" && inspection.status !== "PASSED")
            throw new ConflictException("Invalid state");

          const located = await locateLines(tx, orgId, inspection.lines, new Map());
          await this.postMovements(
            tx, orgId, userId, `${idempotencyKey}:stock`, "INSPECTION", id,
            releaseMovements(located),
            `Inspection passed: ${inspection.inspectionNumber}`,
          );
          await this.clearHeldQuantities(tx, orgId, located.map((line) => line.id));

          await tx.update(invQualityInspections)
            .set({ status: "COMPLETED", completedAt: new Date() })
            .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
          await this.audit.insert(tx, {
            orgId, actorUserId: userId, action: "quality_inspection.passed",
            resourceType: "inspection", resourceId: String(id),
          });
          return id;
        },
        this.revivedInspectionId,
      ),
    );
    await this.invalidateAfterVerdict(orgId);
    return this.findOne(orgId, id);
  }

  /**
   * Records what each line failed on. No stock moves: the goods stay held
   * precisely because the decision about them has not been made yet.
   */
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

  /**
   * D3. What happens to failed goods, as **one ordered command**.
   *
   * Order is the whole subtlety, and splitting it into three commands is what
   * made it wrong. `blocked_qty` and `quality_hold_qty` are both subsets of
   * `on_hand`, so quarantining held goods without first clearing the hold makes
   * `blocked + hold > on_hand` and the engine refuses the disposition outright;
   * scrapping them without clearing it drives `on_hand` below a hold that is
   * still standing, which the same guard refuses. Every release therefore comes
   * first, in the same command, where the engine carries each grain's state
   * forward between movements.
   *
   * RETURN_TO_VENDOR releases the hold too: the quality decision has been made
   * and the goods now leave on a vendor return, whose posting issues them from
   * `on_hand` and would be refused by the same guard if a hold were still on
   * them. That leaves rejected goods briefly available, which is the behaviour
   * this path has always had — the fix belongs on the vendor-return post, which
   * is another lane's file.
   */
  async dispose(orgId: string, userId: string, id: number, input: DisposeInspectionInput, idempotencyKey: string) {
    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quality.inspection.dispose", inspectionId: id, lines: input.lines },
        async () => {
          const inspection = await this.loadForVerdict(tx, orgId, id);
          if (inspection.status !== "DISPOSITION_REQUIRED")
            throw new ConflictException("Invalid state");

          const known = new Set(inspection.lines.map((line) => line.id));
          const overrides = new Map<number, number>();
          for (const dl of input.lines) {
            if (!known.has(dl.lineId))
              throw new BadRequestException(`Line ${dl.lineId} not found`);
            if (dl.locationId !== undefined) overrides.set(dl.lineId, dl.locationId);
          }
          const disposed = new Set(input.lines.map((dl) => dl.lineId));
          const located = await locateLines(
            tx,
            orgId,
            inspection.lines.filter((line) => disposed.has(line.id)),
            overrides,
          );

          await this.postMovements(
            tx, orgId, userId, `${idempotencyKey}:stock`, "INSPECTION_DISPOSE", id,
            dispositionMovements(located, input),
            `Inspection disposed: ${inspection.inspectionNumber}`,
          );
          await this.clearHeldQuantities(tx, orgId, located.map((line) => line.id));
          for (const dl of input.lines) {
            await tx.update(invQualityInspectionLines)
              .set({ disposition: dl.disposition })
              .where(and(
                eq(invQualityInspectionLines.id, dl.lineId),
                eq(invQualityInspectionLines.inspectionId, id),
              ));
          }

          await raiseVendorReturns(tx, orgId, userId, input, located, (t) =>
            this.numSeq.next(orgId, "VENDOR_RETURN", t),
          );

          await tx.update(invQualityInspections)
            .set({ status: "COMPLETED", completedAt: new Date() })
            .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
          await this.audit.insert(tx, {
            orgId, actorUserId: userId, action: "quality_inspection.disposed",
            resourceType: "inspection", resourceId: String(id),
            after: { dispositions: input.lines.map((l) => ({ lineId: l.lineId, disposition: l.disposition })) },
          });
          return id;
        },
        this.revivedInspectionId,
      ),
    );
    await this.invalidateAfterVerdict(orgId);
    return this.findOne(orgId, id);
  }

  /**
   * Abandons an inspection, and gives back whatever it was holding.
   *
   * Cancelling used to be a pure status flip, which was harmless while an
   * inspection held nothing. Now that it does, a cancel that leaves the bucket
   * raised strands the goods: no document is left that can release them, and the
   * only route back is a manual stock adjustment.
   */
  async cancel(orgId: string, userId: string, id: number, idempotencyKey: string) {
    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quality.inspection.cancel", inspectionId: id },
        async () => {
          const inspection = await this.loadForVerdict(tx, orgId, id);
          if (inspection.status !== "PENDING" && inspection.status !== "IN_PROGRESS")
            throw new ConflictException("Invalid state");

          const located = await locateLines(tx, orgId, inspection.lines, new Map());
          await this.postMovements(
            tx, orgId, userId, `${idempotencyKey}:stock`, "INSPECTION_CANCEL", id,
            releaseMovements(located),
            `Inspection cancelled: ${inspection.inspectionNumber}`,
          );
          await this.clearHeldQuantities(tx, orgId, located.map((line) => line.id));

          await tx.update(invQualityInspections)
            .set({ status: "CANCELLED", cancelledAt: new Date() })
            .where(and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)));
          await this.audit.insert(tx, {
            orgId, actorUserId: userId, action: "quality_inspection.cancelled",
            resourceType: "inspection", resourceId: String(id),
          });
          return id;
        },
        this.revivedInspectionId,
      ),
    );
    await this.invalidateAfterVerdict(orgId);
    return this.findOne(orgId, id);
  }

  /**
   * D3, item 3 — a completed result is immutable, and a mistake is compensated
   * rather than edited.
   *
   * The correction is a new PENDING inspection carrying copies of the original's
   * lines and naming what it supersedes, so both the wrong verdict and the right
   * one stay readable. It holds nothing: the goods were already released or
   * disposed by the inspection being corrected, and re-raising a hold here would
   * quarantine stock that may since have been sold, counted or shipped. Where the
   * correction needs the goods back under control, the disposition path on the
   * new inspection is what puts them there.
   */
  async correct(orgId: string, userId: string, id: number, input: CorrectInspectionInput) {
    const original = await this.findOne(orgId, id);
    const terminal: readonly string[] = TERMINAL_STATUSES;
    if (!terminal.includes(original.status))
      throw new ConflictException(
        "Only a completed or cancelled inspection is corrected; an open one is still editable",
      );

    const created = await this.db.transaction(async (tx) => {
      const inspectionNumber = await this.numSeq.next(orgId, "INSPECTION", tx);
      const [correction] = await tx.insert(invQualityInspections).values({
        orgId,
        inspectionNumber,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        inspectorUserId: userId,
        status: "PENDING",
        notes: `Correction of ${original.inspectionNumber}`,
        correctsInspectionId: original.id,
        correctionReason: input.reason,
        createdBy: userId,
      }).returning({ id: invQualityInspections.id });
      if (!correction) throw new ConflictException("Could not record the correction");

      if (original.lines.length > 0) {
        await tx.insert(invQualityInspectionLines).values(
          original.lines.map((line) => ({
            orgId,
            inspectionId: correction.id,
            productVariantId: line.productVariantId,
            locationId: line.locationId,
            lotId: line.lotId,
            serialId: line.serialId,
            quantity: line.quantity,
            sampleQuantity: line.sampleQuantity,
            planVersionId: line.planVersionId,
          })),
        );
      }

      await this.audit.insert(tx, {
        orgId, actorUserId: userId, action: "quality_inspection.corrected",
        resourceType: "inspection", resourceId: String(correction.id),
        before: { inspectionId: original.id, status: original.status },
        after: { reason: input.reason },
      });
      return correction.id;
    }).catch((error: unknown) => {
      // The partial unique index is what makes "one correction per mistake" true
      // when two of them race; a read-then-write check always loses that.
      if (isUniqueViolation(error))
        throw new ConflictException("This inspection has already been corrected");
      throw error;
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId));
    return this.findOne(orgId, created);
  }

  /** The inspection and its lines, read on the caller's transaction. */
  private async loadForVerdict(tx: Tx, orgId: string, id: number) {
    const row = await tx.query.invQualityInspections.findFirst({
      where: and(eq(invQualityInspections.id, id), eq(invQualityInspections.orgId, orgId)),
      with: { lines: true },
    });
    if (!row) throw new NotFoundException("Not found");
    return row;
  }

  private postMovements(
    tx: Tx,
    orgId: string,
    userId: string,
    idempotencyKey: string,
    sourceType: string,
    inspectionId: number,
    movements: StockMovement[],
    reason: string,
  ): Promise<unknown> {
    // A command with no movements is not a command. Every verdict reaches here,
    // including the ones with nothing to move — a manual inspection that never
    // held anything, or a delivery released line by line.
    if (movements.length === 0) return Promise.resolve(undefined);
    return this.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey,
      sourceType,
      sourceId: String(inspectionId),
      reason,
      movements,
    });
  }

  private async clearHeldQuantities(tx: Tx, orgId: string, lineIds: readonly number[]): Promise<void> {
    if (lineIds.length === 0) return;
    await tx.update(invQualityInspectionLines)
      .set({ heldQuantity: "0" })
      .where(and(
        eq(invQualityInspectionLines.orgId, orgId),
        inArray(invQualityInspectionLines.id, [...lineIds]),
      ));
  }

  private async invalidateAfterVerdict(orgId: string): Promise<void> {
    await Promise.all([
      this.engine.invalidateCaches(orgId),
      this.cache.invalidateNamespace(CACHE_KEYS.invQualityInspectionsNamespace(orgId)),
    ]);
  }

  private readonly revivedInspectionId = (stored: unknown): number => {
    const id = revivedId(stored);
    if (!Number.isInteger(id))
      throw new ConflictException("The stored result for this key is unreadable");
    return id;
  };
}

