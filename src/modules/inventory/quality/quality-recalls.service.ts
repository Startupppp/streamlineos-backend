import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
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
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { isPositive } from "../stock-engine/decimal";
import { runIdempotent } from "../stock-engine/idempotency";
import { RecallSimulationService, type RecallImpact } from "./recall-simulation.service";

/** What the idempotent unit of `create` produces, and replays. */
interface ExecutedRecall {
  recall: { id: number; recallNumber: string };
  /** The (lot, location) grains the engine must quarantine, at their on-hand. */
  quarantine: Array<{
    productVariantId: number;
    locationId: number;
    lotId: number;
    onHand: string;
  }>;
}

/**
 * A replayed recall, rebuilt from the stored JSON.
 *
 * The stored response is JSON that has been through the database, so every
 * number arrived as whatever `jsonb` gave back and a blind cast would be a lie
 * the type system cannot catch — hence a revive rather than an assertion.
 * Quantities stay strings: they are 18,4 numerics, and `Number()` on one is the
 * float arithmetic the ledger rules forbid.
 */
function reviveRecall(stored: unknown): ExecutedRecall {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const recall = typeof row.recall === "object" && row.recall !== null
    ? (row.recall as Record<string, unknown>)
    : {};
  const quarantine = Array.isArray(row.quarantine) ? row.quarantine : [];
  return {
    recall: { id: Number(recall.id ?? 0), recallNumber: String(recall.recallNumber ?? "") },
    quarantine: quarantine.flatMap((q) => {
      const g = typeof q === "object" && q !== null ? (q as Record<string, unknown>) : {};
      if (g.lotId == null || g.locationId == null) return [];
      return [{
        productVariantId: Number(g.productVariantId),
        locationId: Number(g.locationId),
        lotId: Number(g.lotId),
        onHand: String(g.onHand ?? "0"),
      }];
    }),
  };
}

@Injectable()
export class RecallsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
<<<<<<< HEAD
    private readonly warehouseScope: WarehouseScopeService,
    private readonly engine: StockEngineService,
=======
    private readonly engine: StockEngineBatchService,
>>>>>>> origin/main
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
    private readonly simulation: RecallSimulationService,
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

  /**
   * D4 — execute a recall.
   *
   * Two shapes of request reach here. An explicit `lines` list is the caller
   * naming lots and serials outright. A `selection` is the caller naming the
   * *question* — "everything this vendor sent us in March" — and presenting
   * the `evidenceVersion` a simulate returned for it; the simulation is re-run
   * here and a moved picture is a 409, never a silent execution against
   * numbers an operator read ten minutes ago.
   */
  async create(orgId: string, userId: string, input: CreateRecallInput, idempotencyKey: string) {
    const { lines: resolvedLines, impact } = await this.resolveLines(orgId, userId, input);

    // A3/A5/D4. Everything that writes a document — the recall, its lines, the
    // lot flip and the hold records — sits inside one idempotent unit, so a
    // retried request replays all of it or none of it. It used to cover only
    // the recall row: a retry replayed the document and then inserted a second
    // full set of quality holds against the same stock, which is a recall that
    // looks idempotent from the outside and is not.
    //
    // The engine movements stay outside because `executeMany` opens its own
    // transaction; they carry a derived key per (recall, lot, location) and are
    // replay-safe on their own terms.
    const executed = await this.db.transaction(async (tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quality.recall.create", input },
        async (): Promise<ExecutedRecall> => {
      const recallNumber = await this.numSeq.next(orgId, "RECALL", tx);
      const [recall] = await tx.insert(invRecallEvents).values({
        orgId,
        recallNumber,
        title: input.title,
        description: input.description ?? null,
        evidenceVersion: impact?.evidenceVersion ?? null,
        evidenceSnapshot: impact === null ? null : { ...impact },
        createdBy: userId,
      }).returning();
      if (!recall) throw new Error("Insert recall failed");
      const lines = await tx.insert(invRecallLines).values(
        resolvedLines.map(l => ({
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

      const quarantine: ExecutedRecall["quarantine"] = [];
      if (recalledLotIds.length > 0) {
        // The allocator refuses any lot whose status is not ACTIVE, under every
        // strategy, so this flip is what actually stops the goods moving —
        // the holds below are the document trail, not the enforcement.
        await tx.update(invLots)
          .set({ status: "RECALLED" })
          .where(and(inArray(invLots.id, recalledLotIds), eq(invLots.orgId, orgId)));

        // Projected, not `select()`: an unprojected read here returned every
        // column of every matching stock row, and `parseFloat` on an 18,4
        // numeric is the float arithmetic the ledger rules forbid — a lot
        // holding 0.0001 units is on the shelf and must be recalled with the
        // rest.
        const levels = await tx
          .select({
            productVariantId: invStockLevels.productVariantId,
            locationId: invStockLevels.locationId,
            lotId: invStockLevels.lotId,
            onHand: invStockLevels.onHand,
          })
          .from(invStockLevels)
          .where(and(eq(invStockLevels.orgId, orgId), inArray(invStockLevels.lotId, recalledLotIds)));

        for (const level of levels) {
          if (level.lotId === null || level.lotId === undefined) continue;
          if (!isPositive(level.onHand)) continue;
          quarantine.push({
            productVariantId: level.productVariantId,
            locationId: level.locationId,
            lotId: level.lotId,
            onHand: level.onHand,
          });
        }

        if (quarantine.length > 0) {
          await tx.insert(invQualityHolds).values(
            quarantine.map(grain => ({
              orgId,
              productVariantId: grain.productVariantId,
              locationId: grain.locationId,
              lotId: grain.lotId,
              quantity: grain.onHand,
              reason: `Recall ${recallNumber}`,
              createdBy: userId,
            })),
          );
        }
      }

      await this.audit.insert(tx, {
        orgId, actorUserId: userId, action: "recall.created",
        resourceType: "recall", resourceId: String(recall.id),
        after: {
          recallNumber,
          linesCount: lines.length,
          evidenceVersion: impact?.evidenceVersion ?? null,
        },
      });

      // G3. An audit row is a private record of who did what; nothing subscribes
      // to a table. A recall is the one inventory event a warehouse most needs
      // pushed at it — the lots are already RECALLED and the allocator is already
      // refusing them, so this is what explains why. Inside the transaction, so
      // it commits with the recall or not at all, and through the outbox, so the
      // recall still commits when the notifier is down.
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "inv_recall_event",
        aggregateId: String(recall.id),
        aggregateVersion: 1,
        eventType: "inventory.recall.opened",
        payload: {
          recallId: recall.id,
          referenceNumber: recallNumber,
          title: input.title,
          lotCount: lines.length,
          quarantinedGrains: quarantine.length,
          openedByUserId: userId,
        },
        occurredAt: new Date(),
      });

      return { recall: { id: recall.id, recallNumber }, quarantine };
        },
        (stored) => reviveRecall(stored),
      ),
    );

    const recallCommands = executed.quarantine.map(grain => ({
      idempotencyKey: `recall:${executed.recall.id}:lot:${grain.lotId}:loc:${grain.locationId}`,
      sourceType: "RECALL",
      sourceId: String(executed.recall.id),
      // A recall quarantines the goods; it does not make them disappear.
      // Zeroing ON_HAND as well drove available negative and destroyed the
      // count of what is physically on the shelf — which is exactly the
      // number a recall needs to report.
      movements: [
        { transactionType: "QUARANTINE_IN", productVariantId: grain.productVariantId, locationId: grain.locationId, lotId: grain.lotId, quantityDelta: grain.onHand, qualityBucket: "QUALITY_HOLD" as const },
      ],
    }));

    if (recallCommands.length > 0) {
      await this.engine.executeMany(orgId, userId, recallCommands);
    }

    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityRecallsNamespace(orgId));
    return this.findOne(orgId, executed.recall.id);
  }

  /**
   * The lines a create request means, and the evidence it was justified by.
   *
   * An explicit `lines` list is taken at face value and carries no evidence. A
   * `selection` is re-simulated here — not trusted from the client — and the
   * hash compared: a selection that has since gained or lost a lot, moved
   * stock, or shipped another carton produces a different version, and the
   * execute is refused rather than acting on the operator's stale reading.
   */
  private async resolveLines(
    orgId: string,
    userId: string,
    input: CreateRecallInput,
  ): Promise<{
    lines: Array<{ productVariantId?: number; lotId?: number; serialId?: number }>;
    impact: RecallImpact | null;
  }> {
    if (input.selection === undefined) {
      // The schema's refinement guarantees one of the two is present.
      return { lines: input.lines ?? [], impact: null };
    }

    const impact = await this.simulation.simulate(orgId, userId, input.selection);

    if (impact.evidenceVersion !== input.evidenceVersion) {
      throw new ConflictException({
        code: "RECALL_EVIDENCE_STALE",
        message:
          "The stock picture changed since this recall was simulated. Re-run the simulation and review the impact before executing.",
        expectedEvidenceVersion: impact.evidenceVersion,
        submittedEvidenceVersion: input.evidenceVersion,
      });
    }

    if (impact.lots.length === 0) {
      throw new BadRequestException("This selection matches no lots, so there is nothing to recall");
    }

    return {
      lines: impact.lots.map((lot) => ({
        productVariantId: lot.productVariantId,
        lotId: lot.lotId,
      })),
      impact,
    };
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
    // `notes` is the client's name for the recall's narrative, and the column
    // holding it is `description`. The field was accepted and then dropped on
    // the floor: the UI's notes editor reported success and stored nothing.
    if (input.notes !== undefined) patch.description = input.notes;
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
