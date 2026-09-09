import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
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
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { isPositive } from "../stock-engine/decimal";
import { runIdempotent } from "../stock-engine/idempotency";
import { RecallSimulationService, type RecallImpact } from "./recall-simulation.service";

/**
 * What the quarantine leg did to one recall line, stored on the line.
 *
 * `OPEN` is not in this union on purpose. It is the column default and means
 * "no outcome was recorded" — every line of every recall raised before INV-33.
 * The UI renders it as pending rather than as success, because a recall that
 * cannot say what it held is exactly the one nobody should trust.
 */
export type RecallLineOutcome = "QUARANTINED" | "NOTHING_TO_QUARANTINE" | "NOT_QUARANTINABLE";

/** What the idempotent unit of `create` produces, and replays. */
interface ExecutedRecall {
  recall: { id: number; recallNumber: string };
  /** The exact stock grains the engine quarantined, at their on-hand. */
  quarantine: Array<{
    productVariantId: number;
    locationId: number;
    lotId: number;
    handlingUnitId: number | null;
    ownership: "OWNED" | "VENDOR" | "CUSTOMER";
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
        handlingUnitId: g.handlingUnitId == null ? null : Number(g.handlingUnitId),
        ownership:
          g.ownership === "VENDOR" || g.ownership === "CUSTOMER"
            ? g.ownership
            : "OWNED",
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
    private readonly warehouseScope: WarehouseScopeService,
    private readonly engine: StockEngineBatchService,
    private readonly numSeq: NumberSequenceService,
    private readonly audit: InventoryAuditService,
    private readonly simulation: RecallSimulationService,
  ) {}

  /**
   * INV-109. A recall carries no warehouse of its own; it is attributable
   * through the lots and variants its lines name, and those through the stock
   * they hold. A recall touching nothing an operator can see stays out of their
   * list — and, since INV-SCOPE-QUALITY, out of their detail too.
   *
   * The NULL rule falls out of the EXISTS and is worth naming: a recall whose
   * lines match no stock row in any of the caller's warehouses — including one
   * matching no stock at all — is **excluded**. It is not the ASN rule, where an
   * unattributed row stays visible to everyone; a recall is attributed
   * indirectly, so "no attribution" here means "touches nothing you hold", not
   * "not yet filled in". Lives in one place so the list and the detail cannot
   * drift apart, which is how this defect got written in the first place.
   *
   * Hiding a safety event reads uncomfortably, so worth being explicit:
   * visibility is not what stops recalled goods moving. The allocator refuses a
   * recalled lot under every strategy regardless of who is looking, so scoping
   * changes what an operator reads, never what the engine permits.
   */
  private recallInScope(orgId: string, scope: ResolvedWarehouseScope): SQL | undefined {
    if (scope.unrestricted) return undefined;
    return sql`EXISTS (
      SELECT 1
      FROM inv_recall_lines rl
      JOIN inv_stock_levels sl
        ON sl.org_id = rl.org_id
       AND (sl.lot_id = rl.lot_id
            OR (rl.lot_id IS NULL AND sl.product_variant_id = rl.product_variant_id))
      WHERE rl.org_id = ${orgId}
        AND rl.recall_id = ${invRecallEvents.id}
        AND ${scope.location(sql`sl.location_id`)}
    )`;
  }

  async list(orgId: string, userId: string, query: ListRecallsQueryInput) {
    const { status, page, limit } = query;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    // The resolved scope belongs in the key. Without it the first caller's
    // warehouses are cached and served to the next, which defeats the
    // predicate in both directions.
    const hash = `${scope.key}:${status ?? ""}:${limit}:${offset}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invQualityRecallsNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invRecallEvents.orgId, orgId)];

        const inScope = this.recallInScope(orgId, scope);
        if (inScope !== undefined) conditions.push(inScope);

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

  /**
   * One recall, read by id.
   *
   * `list` above resolves the caller's warehouses; this took no `userId`, so it
   * answered on `org_id` and the id alone — and it returns more than the list
   * does, since it goes on to name every shipment the recalled lots went out
   * on. An operator who could not see the recall could still read its whole
   * blast radius, customers included, by walking the ids.
   *
   * A miss is 404, never 403 (§4): telling somebody they are forbidden from
   * recall 91 tells them recall 91 exists.
   */
  async findOne(orgId: string, userId: string, id: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.loadRecallDetail(orgId, id, this.recallInScope(orgId, scope));
  }

  /**
   * The same detail without the warehouse gate, for the one path entitled to it.
   *
   * `create` ends by handing back the recall it has just raised, and gating that
   * would 404 an operator against their own new record — a recall raised against
   * lots that turn out to hold no stock in their warehouses matches no EXISTS at
   * all. A named private method rather than a flag on `findOne`, so a future
   * route cannot be pointed at the ungated read by accident; this is the shape
   * the ASN detail fix used (`loadAsnUnscoped`), for the same reason.
   */
  private loadRecallUnscoped(orgId: string, id: number) {
    return this.loadRecallDetail(orgId, id, undefined);
  }

  private async loadRecallDetail(orgId: string, id: number, inScope: SQL | undefined) {
    const recall = await this.db.query.invRecallEvents.findFirst({
      where: and(eq(invRecallEvents.id, id), eq(invRecallEvents.orgId, orgId), inScope),
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
    // A3/A5/D4. Everything that writes a document — the recall, its lines, the
    // lot flip, the hold records and the quarantine movements — sits inside one idempotent unit, so a
    // retried request replays all of it or none of it. It used to cover only
    // the recall row: a retry replayed the document and then inserted a second
    // full set of quality holds against the same stock, which is a recall that
    // looks idempotent from the outside and is not.
    const executed = await this.db.transaction(async (tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quality.recall.create", input },
        async (): Promise<ExecutedRecall> => {
          const { lines: resolvedLines, impact } = await this.resolveLines(orgId, userId, input);
          const recallNumber = await this.numSeq.next(orgId, "RECALL", tx);
          const [recall] = await tx
            .insert(invRecallEvents)
            .values({
              orgId,
              recallNumber,
              title: input.title,
              description: input.description ?? null,
              evidenceVersion: impact?.evidenceVersion ?? null,
              evidenceSnapshot: impact === null ? null : { ...impact },
              createdBy: userId,
            })
            .returning();
          if (!recall) throw new Error("Insert recall failed");
          const lines = await tx
            .insert(invRecallLines)
            .values(
              resolvedLines.map(l => ({
                orgId,
                recallId: recall.id,
                productVariantId: l.productVariantId ?? null,
                lotId: l.lotId ?? null,
                serialId: l.serialId ?? null,
              })),
            )
            .returning();
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
                handlingUnitId: invStockLevels.handlingUnitId,
                ownership: invStockLevels.ownership,
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
                handlingUnitId: level.handlingUnitId ?? null,
                ownership: level.ownership,
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
                  handlingUnitId: grain.handlingUnitId,
                  ownership: grain.ownership,
                  quantity: grain.onHand,
                  reason: `Recall ${recallNumber}`,
                  createdBy: userId,
                })),
              );

              const recallCommands = quarantine.map(grain => ({
                idempotencyKey:
                  `recall:${recall.id}:lot:${grain.lotId}:loc:${grain.locationId}:` +
                  `hu:${grain.handlingUnitId ?? "none"}:own:${grain.ownership}`,
                sourceType: "RECALL",
                sourceId: String(recall.id),
                // A recall quarantines the goods; it does not make them disappear.
                // Zeroing ON_HAND as well drove available negative and destroyed the
                // count of what is physically on the shelf — which is exactly the
                // number a recall needs to report.
                movements: [
                  {
                    transactionType: "QUARANTINE_IN",
                    productVariantId: grain.productVariantId,
                    locationId: grain.locationId,
                    lotId: grain.lotId,
                    handlingUnitId: grain.handlingUnitId,
                    ownership: grain.ownership,
                    quantityDelta: grain.onHand,
                    qualityBucket: "QUALITY_HOLD" as const,
                  },
                ],
              }));

              await this.engine.executeManyInTx(tx, orgId, userId, recallCommands);
            }
          }

          // INV-33. What the quarantine actually did to each line, recorded on
          // the line rather than left to be inferred.
          //
          // `inv_recall_lines.status` has existed since the table did, defaulted
          // to OPEN and was never written by anything and never read by anything.
          // The information it should hold is computed a few lines above and was
          // being dropped on the floor: `create` returns `findOne`, which knows
          // the lines and the affected shipments and nothing at all about whether
          // a single unit was held.
          //
          // That matters because a recall can commit having quarantined nothing,
          // and the screen said OPEN either way:
          //  - a line naming a lot with no stock on hand — the lot is RECALLED so
          //    the allocator refuses it, but there is nothing on a shelf to hold;
          //  - a line naming only a serial or only a variant — `recalledLotIds` is
          //    empty, so the lot flip never runs either. Nothing is blocked at all
          //    and the goods stay sellable. That is the silent failure.
          const quarantinedLotIds = new Set(quarantine.map((grain) => grain.lotId));
          const byOutcome = new Map<RecallLineOutcome, number[]>();
          for (const line of lines) {
            const outcome: RecallLineOutcome =
              line.lotId === null || line.lotId === undefined
                ? "NOT_QUARANTINABLE"
                : quarantinedLotIds.has(line.lotId)
                  ? "QUARANTINED"
                  : "NOTHING_TO_QUARANTINE";
            const bucket = byOutcome.get(outcome);
            if (bucket) bucket.push(line.id);
            else byOutcome.set(outcome, [line.id]);
          }
          for (const [outcome, lineIds] of byOutcome) {
            await tx
              .update(invRecallLines)
              .set({ status: outcome })
              .where(and(eq(invRecallLines.orgId, orgId), inArray(invRecallLines.id, lineIds)));
          }
          const unheldLineCount = lines.length - (byOutcome.get("QUARANTINED")?.length ?? 0);

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
              // A subscriber can alarm on this without re-reading the lines. A
              // recall whose every line is unheld held nothing anywhere.
              unheldLineCount,
              openedByUserId: userId,
            },
            occurredAt: new Date(),
          });

          return { recall: { id: recall.id, recallNumber }, quarantine };
        },
        (stored) => reviveRecall(stored),
      ),
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invQualityRecallsNamespace(orgId));
    return this.loadRecallUnscoped(orgId, executed.recall.id);
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

  /**
   * Closing or renarrating a recall — the same gate the detail now applies.
   *
   * This one had `userId` in hand and spent it only on the audit row, so an
   * operator holding one warehouse could CLOSE a recall raised against stock in
   * another. Closing is what stops a safety event being chased, so it is a
   * worse thing to reach than the read beside it.
   */
  async update(orgId: string, userId: string, id: number, input: UpdateRecallInput) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const recall = await this.db.query.invRecallEvents.findFirst({
      where: and(
        eq(invRecallEvents.id, id),
        eq(invRecallEvents.orgId, orgId),
        this.recallInScope(orgId, scope),
      ),
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
