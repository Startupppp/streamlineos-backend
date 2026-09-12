import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  invRecallEvents,
  invRecallLines,
  invLots,
  invStockLevels,
  invQualityHolds,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { StockEngineBatchService } from "../../stock-engine/stock-engine-batch.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { isPositive } from "../../stock-engine/decimal";
import { runIdempotent } from "../../stock-engine/idempotency";
import { RecallSimulationService } from "../recall-simulation.service";
import type { CreateRecallInput } from "../dto/quality.schemas";
import { resolveLines } from "./recall-lines";
import {
  reviveRecall,
  type ExecutedRecall,
  type RecallDetail,
  type RecallLineOutcome,
} from "./recall-executed";

/**
 * Raising a recall: resolve what it covers, quarantine it, record it.
 *
 * `reloadUnscopedRecall` is a CALLBACK rather than an imported read.
 * `loadRecallUnscoped` is the read that skips `recallInScope`, and
 * `__tests__/recall-detail-scope.spec.ts` pins it as a named PRIVATE method so
 * a future route cannot be pointed at it by accident — a recall raised against
 * lots holding no stock in the raiser's warehouses matches no EXISTS, so gating
 * the create tail would 404 an operator against their own new record on exactly
 * the recalls most worth raising. Exporting the read from `lib/` would undo
 * that; a bound closure keeps it on the service.
 */
export interface RecallCreateDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly engine: StockEngineBatchService;
  readonly numSeq: NumberSequenceService;
  readonly audit: InventoryAuditService;
  readonly simulation: RecallSimulationService;
  readonly reloadUnscopedRecall: (orgId: string, id: number) => Promise<RecallDetail>;
}

export async function createRecall(
  deps: RecallCreateDeps,orgId: string, userId: string, input: CreateRecallInput, idempotencyKey: string) {
  // A3/A5/D4. Everything that writes a document — the recall, its lines, the
  // lot flip, the hold records and the quarantine movements — sits inside one idempotent unit, so a
  // retried request replays all of it or none of it. It used to cover only
  // the recall row: a retry replayed the document and then inserted a second
  // full set of quality holds against the same stock, which is a recall that
  // looks idempotent from the outside and is not.
  const executed = await deps.db.transaction(async (tx) =>
    runIdempotent(
      tx,
      orgId,
      idempotencyKey,
      { command: "inventory.quality.recall.create", input },
      async (): Promise<ExecutedRecall> => {
        const { lines: resolvedLines, impact } = await resolveLines(deps, orgId, userId, input);
        const recallNumber = await deps.numSeq.next(orgId, "RECALL", tx);
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

            await deps.engine.executeManyInTx(tx, orgId, userId, recallCommands);
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

        await deps.audit.insert(tx, {
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

  await deps.cache.invalidateNamespace(CACHE_KEYS.invQualityRecallsNamespace(orgId));
  return deps.reloadUnscopedRecall(orgId, executed.recall.id);
}
