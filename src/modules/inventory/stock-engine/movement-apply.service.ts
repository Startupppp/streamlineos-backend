import { BadRequestException, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invStockLevels, invStockTransactions, invIdempotencyKeys } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "./inventory-audit.service";
import { MovementCostingService } from "./movement-costing.service";
import { addDec, mulDec, cmpDec, isPositive, isNegative } from "./decimal";
import { levelKey, type LockedLevel } from "./stock-level-locks";
import { emitStockMovementPosted } from "./stock-events";
import { inventoryCounters } from "../observability/inventory-counters";
import type { CostingLookup } from "./costing-context";
import {
  INV_ERRORS,
  type InvSettingsRow,
  type StockMovement,
  type StockEngineCommand,
  type StockEngineResult,
} from "./stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type QuantityBucket = "ON_HAND" | "BLOCKED" | "QUALITY_HOLD";

/** The quantity the named bucket holds, for the ledger's before/after pair. */
function bucketQuantities(
  bucket: QuantityBucket,
  level: { onHand: string; blockedQty: string; qualityHoldQty: string },
): string {
  if (bucket === "BLOCKED") return level.blockedQty;
  if (bucket === "QUALITY_HOLD") return level.qualityHoldQty;
  return level.onHand;
}

/**
 * A hold or a block is a claim on stock that is physically present, so the three
 * buckets have to stay consistent with one another and not merely non-negative
 * one at a time.
 */
function assertBucketsCoherent(
  next: { onHand: string; blockedQty: string; qualityHoldQty: string },
  allowNegativeStock: boolean,
): void {
  if (!allowNegativeStock && isNegative(next.onHand)) {
    throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
  }
  if (isNegative(next.blockedQty) || isNegative(next.qualityHoldQty)) {
    throw new BadRequestException({ code: INV_ERRORS.RELEASE_EXCEEDS_HELD });
  }
  if (
    !allowNegativeStock &&
    cmpDec(addDec(next.blockedQty, next.qualityHoldQty), next.onHand) > 0
  ) {
    throw new BadRequestException({ code: INV_ERRORS.HOLD_EXCEEDS_ON_HAND });
  }
}

/**
 * A2. Resolve `costFromMovementIndex` against the costs already derived in this
 * command. Only a backward reference is legal — a movement cannot inherit from
 * one that has not been costed yet.
 */
function resolveInheritedCost(
  movement: StockMovement,
  movementIndex: number,
  derived: ReadonlyArray<string | null>,
): string | null {
  const source = movement.costFromMovementIndex;
  if (source === undefined) return null;
  if (!Number.isInteger(source) || source < 0 || source >= movementIndex) {
    throw new BadRequestException({
      code: INV_ERRORS.INVALID_DOCUMENT_STATE,
      message: `costFromMovementIndex ${source} must reference an earlier movement`,
    });
  }
  return derived[source] ?? null;
}

export function resolvePostingDate(cmd: StockEngineCommand): string {
  return cmd.postingDate ?? new Date().toISOString().slice(0, 10);
}

/** What one command needs that its caller has already resolved for the whole request. */
export interface MovementApplyContext {
  settings: InvSettingsRow;
  costing: CostingLookup;
  /**
   * Every grain this command touches, already locked. Mutated in place as
   * movements land, so a second command over the same grain in the same batch
   * reads the first one's result rather than a stale snapshot.
   */
  levels: Map<string, LockedLevel>;
  postingDate: string;
}

/**
 * R1 — the one place a stock movement is written.
 *
 * `executeInTx` and `executeMany` used to carry byte-identical copies of this
 * body: the bucket arithmetic, the coherence guard, the costing plan, the ledger
 * insert, the projection update, the capacity check, the audit row, the low-stock
 * signal, the event and the idempotency completion. Every engine change had to be
 * made twice, and at least one — the location capacity guard — was only ever made
 * once, so the batch path enforced a constraint the single path did not.
 *
 * The two callers still differ in exactly one respect, and it is the reason the
 * batch path exists at all: `executeMany` locks every grain across every command
 * in one ordered statement, so a batch cannot deadlock against itself. That lock
 * is the caller's job; applying a command to the rows it produced is this one's.
 */
@Injectable()
export class MovementApplyService {
  constructor(
    private readonly auditService: InventoryAuditService,
    private readonly movementCosting: MovementCostingService,
  ) {}

  /**
   * Locations with no capacity recorded are unlimited, which is the common case
   * and must stay free. One aggregate covers every raised location; the HAVING
   * does the comparison in the database so a numeric never becomes a float on
   * the way to a decision.
   */
  async assertLocationCapacity(
    tx: Tx,
    orgId: string,
    movements: StockEngineCommand["movements"],
  ): Promise<void> {
    const raised = [
      ...new Set(
        movements
          .filter(
            (m) =>
              (m.qualityBucket ?? "ON_HAND") === "ON_HAND" &&
              isPositive(m.quantityDelta),
          )
          .map((m) => m.locationId),
      ),
    ];
    if (raised.length === 0) return;

    const over = await tx.execute<{ id: number; code: string; capacity: string; total: string }>(sql`
      SELECT l.id, l.code, l.capacity::text AS capacity, COALESCE(SUM(sl.on_hand), 0)::text AS total
      FROM inv_locations l
      LEFT JOIN inv_stock_levels sl
        ON sl.org_id = l.org_id AND sl.location_id = l.id
      WHERE l.org_id = ${orgId}
        AND l.id IN (${sql.join(raised.map((id) => sql`${id}`), sql`, `)})
        AND l.capacity IS NOT NULL
      GROUP BY l.id, l.code, l.capacity
      HAVING COALESCE(SUM(sl.on_hand), 0) > l.capacity
    `);

    // A row with no capacity cannot be a violation. The HAVING clause already
    // guarantees that, so this is belt and braces against a caller handing back
    // rows this query did not shape.
    const breaches = over.filter((row) => row.capacity != null);
    if (breaches.length > 0) {
      const detail = breaches
        .map((row) => `${row.code} holds ${row.total} against a capacity of ${row.capacity}`)
        .join("; ");
      throw new BadRequestException({
        code: INV_ERRORS.LOCATION_CAPACITY_EXCEEDED,
        message: `Location capacity exceeded: ${detail}`,
      });
    }
  }

  async apply(
    tx: Tx,
    orgId: string,
    userId: string,
    cmd: StockEngineCommand,
    ctx: MovementApplyContext,
  ): Promise<StockEngineResult> {
    const { settings, costing, levels, postingDate } = ctx;
    const txnIds: number[] = [];
    const cmdLevels: StockEngineResult["levels"] = [];
    const decreasedVariantIds = new Set<number>();

    // A2. What each movement actually cost, so a later movement in the same
    // command can be received at the figure an earlier one turned out to
    // consume rather than at an estimate of it.
    const derivedUnitCost: Array<string | null> = [];

    for (const [movementIndex, movement] of cmd.movements.entries()) {
      const key = levelKey({
        productVariantId: movement.productVariantId,
        locationId: movement.locationId,
        lotId: movement.lotId ?? null,
        serialId: movement.serialId ?? null,
        handlingUnitId: movement.handlingUnitId ?? null,
        ownership: movement.ownership ?? "OWNED",
      });
      const level = levels.get(key);

      if (!level)
        throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

      const bucket = movement.qualityBucket ?? "ON_HAND";
      const delta = movement.quantityDelta;
      const positive = isPositive(delta);

      const newOnHand =
        bucket === "ON_HAND" ? addDec(level.onHand, delta) : level.onHand;
      const newBlocked =
        bucket === "BLOCKED"
          ? addDec(level.blockedQty, delta)
          : level.blockedQty;
      const newQualityHold =
        bucket === "QUALITY_HOLD"
          ? addDec(level.qualityHoldQty, delta)
          : level.qualityHoldQty;

      assertBucketsCoherent(
        { onHand: newOnHand, blockedQty: newBlocked, qualityHoldQty: newQualityHold },
        settings.allowNegativeStock,
      );

      // before/after describe the bucket this movement actually moved. Recording
      // on-hand for a hold or block movement made after = before + change false
      // for those rows, so the ledger's own arithmetic could not be a constraint.
      const bucketBefore = bucketQuantities(bucket, level);
      const bucketAfter = bucketQuantities(bucket, {
        onHand: newOnHand,
        blockedQty: newBlocked,
        qualityHoldQty: newQualityHold,
      });

      // A2. The cost side is decided before the fact row is written, so the row
      // carries its cost from birth. It used to be inserted cost-less and
      // UPDATEd a moment later, which is the only reason this table had to stay
      // writable at all.
      const inheritedUnitCost = resolveInheritedCost(
        movement,
        movementIndex,
        derivedUnitCost,
      );
      const costingInput = {
        orgId,
        costing,
        movement,
        delta,
        unitCost: inheritedUnitCost ?? movement.unitCost ?? null,
        onHandBefore: level.onHand,
        averageCostBefore: level.averageCost,
        allowNegativeStock: settings.allowNegativeStock,
        sourceType: cmd.sourceType ?? null,
        sourceId: cmd.sourceId,
      };
      const planned =
        bucket === "ON_HAND" && !movement.settledCost
          ? await this.movementCosting.plan(tx, costingInput)
          : null;

      const unitCost = movement.settledCost
        ? movement.settledCost.unitCost
        : planned
          ? planned.unitCost
          : costingInput.unitCost;
      const totalCost = movement.settledCost
        ? movement.settledCost.totalCost
        : planned
          ? planned.totalCost
          : costingInput.unitCost && positive
            ? mulDec(costingInput.unitCost, delta)
            : null;
      derivedUnitCost[movementIndex] = unitCost;

      const [txnRow] = await tx
        .insert(invStockTransactions)
        .values({
          orgId,
          productVariantId: movement.productVariantId,
          locationId: movement.locationId,
          lotId: movement.lotId ?? null,
          serialId: movement.serialId ?? null,
          handlingUnitId: movement.handlingUnitId ?? null,
          ownership: movement.ownership ?? "OWNED",
          transactionType:
            movement.transactionType as (typeof invStockTransactions.$inferInsert)["transactionType"],
          quantityBucket: bucket,
          quantityChange: delta,
          quantityBefore: bucketBefore,
          quantityAfter: bucketAfter,
          unitCost,
          totalCost,
          correctionOfTransactionId: movement.correctionOfTransactionId ?? null,
          idempotencyKey: cmd.idempotencyKey,
          postingDate,
          reason: cmd.reason ?? null,
          referenceType: cmd.sourceType,
          referenceId: cmd.sourceId,
          metadata: null,
          notes: null,
          createdBy: userId,
        })
        .returning({ id: invStockTransactions.id });

      if (!txnRow) throw new Error("Failed to insert stock transaction");
      txnIds.push(txnRow.id);

      let newAvgCost = level.averageCost;
      if (planned) {
        newAvgCost = await this.movementCosting.commit(
          tx,
          costingInput,
          planned,
          txnRow.id,
        );
      }

      await tx
        .update(invStockLevels)
        .set({
          onHand: newOnHand,
          blockedQty: newBlocked,
          qualityHoldQty: newQualityHold,
          averageCost: newAvgCost,
        })
        .where(eq(invStockLevels.id, level.id));

      // The snapshot is taken once, so a command with two movements over the
      // same grain must carry the first one's result forward or the second
      // reads a stale before-quantity and overwrites it.
      levels.set(key, {
        ...level,
        onHand: newOnHand,
        blockedQty: newBlocked,
        qualityHoldQty: newQualityHold,
        averageCost: newAvgCost,
      });

      if (!positive && bucket === "ON_HAND") {
        decreasedVariantIds.add(movement.productVariantId);
      }

      cmdLevels.push({
        productVariantId: movement.productVariantId,
        locationId: movement.locationId,
        onHand: newOnHand,
      });
    }

    // INV-202. A bin's capacity was settable in the warehouse editor and read by
    // nothing, which made it decorative -- an operator could put a pallet into a
    // location the building has no room for and the system would agree. Checked
    // after the levels are written so it sees the resulting position rather than
    // a prediction of it, and only for locations a movement actually raised: a
    // capacity check on a location stock just left is a query for no reason.
    await this.assertLocationCapacity(tx, orgId, cmd.movements);

    await this.auditService.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "stock.movement",
      resourceType: cmd.sourceType,
      resourceId: cmd.sourceId,
      after: { transactionIds: txnIds },
    });

    await this.movementCosting.emitLowStock(
      tx,
      orgId,
      decreasedVariantIds,
      cmdLevels,
      cmd.sourceType,
      cmd.sourceId,
    );

    // G6. Counted here rather than at the controller: this is the point past
    // which the movement is written and the command has succeeded. A counter at
    // the edge would also count commands the engine went on to refuse.
    //
    // It counts an *applied* command, not a committed one. An in-memory counter
    // cannot roll back, so a command that applies here and then fails on the
    // event write or the idempotency completion is still counted a success. The
    // window is two statements wide and the ratio it feeds — conflicts over
    // attempts — is not distorted by it, but an operator reading these numbers
    // should know they are attempts that got this far rather than commits.
    inventoryCounters.increment(orgId, "stock.command.success");

    const engineResult: StockEngineResult = { transactionIds: txnIds, levels: cmdLevels };

    // A5. Inside the transaction, so the movement and the event commit together
    // or not at all — an event published for a movement that rolled back has
    // every consumer acting on stock that does not exist. A replayed command
    // returns before it reaches here, which is what makes a retry emit nothing.
    await emitStockMovementPosted(tx, orgId, userId, cmd, engineResult, postingDate);

    await tx
      .update(invIdempotencyKeys)
      .set({ status: "COMPLETED", response: { ...engineResult } as Record<string, unknown> })
      .where(
        and(
          eq(invIdempotencyKeys.orgId, orgId),
          eq(invIdempotencyKeys.idempotencyKey, cmd.idempotencyKey),
        ),
      );

    return engineResult;
  }
}
