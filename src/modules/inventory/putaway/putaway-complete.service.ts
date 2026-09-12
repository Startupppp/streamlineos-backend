import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invPutawayTaskLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { LaborService } from "../labor/labor.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { lockLevels, levelKey, type LevelGrain } from "../stock-engine/stock-level-locks";
import { runIdempotent } from "../stock-engine/idempotency";
import { cmpDec, addDec, subDec, isPositive } from "../stock-engine/decimal";
import type { StockMovement } from "../stock-engine/stock-engine.types";
import { assertDestinationUsable, findQuarantineLocation } from "./putaway-destination";
import {
  revivePutawayCompletion,
  type PutawayCompletionResult,
} from "./putaway-completion-result";
import type { CompletePutawayInput } from "./dto/putaway.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface TaskRow extends Record<string, unknown> {
  id: number;
  status: string;
  warehouse_id: number;
  from_location_id: number;
  task_number: string;
  assigned_to: string | null;
}

interface LineRow extends Record<string, unknown> {
  id: number;
  product_variant_id: number;
  lot_id: number | null;
  serial_id: number | null;
  quantity: string;
  quantity_moved: string;
  disposition: string;
  to_location_id: number | null;
}

/** One line's plan, resolved before any movement is built. */
interface PlannedLine {
  line: LineRow;
  destinationId: number;
  quantity: string;
  blockedCarry: string;
}

/** The smaller of two decimals, exact. */
function minDec(a: string, b: string): string {
  return cmpDec(a, b) <= 0 ? a : b;
}

/**
 * B3, item 1 — walking the task, and what that does to the ledger.
 *
 * A putaway is a relocation, so it is a transfer-like movement and it goes
 * through the stock engine like every other one: `TRANSFER_OUT` at the receiving
 * bin, `TRANSFER_IN` at the shelf, in one command. Writing `inv_stock_transactions`
 * directly is not an option — the table is append-only behind a trigger — and it
 * would also skip the valuation layers, the accounting-period gate, the warehouse
 * scope check and the capacity check, which are the entire reason the engine
 * exists.
 *
 * The destination leg inherits the source leg's derived cost by index rather
 * than being handed an estimate. Under weighted average the two agree; under
 * FIFO an issue that crosses a layer boundary does not, and costing the arrival
 * from an average would restate inventory for no reason other than that the
 * goods moved shelf.
 *
 * **Why `blocked_qty` travels with the goods.** It is a subset of `on_hand` at a
 * *grain*, and the grain includes the location. Moving on-hand out of the
 * receiving bin and leaving the blocked quantity behind makes `blocked > on_hand`
 * there, which the engine refuses outright (`HOLD_EXCEEDS_ON_HAND`) — so a
 * putaway of blocked goods would simply be impossible, and blocked goods are
 * exactly what a failed inspection produces and what quarantine routing exists
 * for. So the bucket moves with the units, capped at what is actually blocked,
 * and its legs are ordered around the on-hand legs: out of the bucket before the
 * shelf empties, into it after the shelf fills. Either half in the other order
 * trips the coherence check on one side or the other.
 *
 * **`quality_hold_qty` is refused rather than carried, and that is deliberate.**
 * An active `inv_quality_holds` row names the location its units are standing
 * at, and `QualityHoldsService.release` posts its `QUARANTINE_OUT` there. Moving
 * the bucket without moving that pointer makes the hold unreleasable; moving the
 * pointer is a decision about Quality's own document — and an ambiguous one,
 * since a hold that names no lot covers several grains and a partial putaway
 * moves only some of them. So a grain standing under a hold refuses, with the
 * action that clears it. The hold still *routes* the line to quarantine, which
 * is the half of item 2 that belongs here.
 */
@Injectable()
export class PutawayCompleteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly projection: StockProjectionService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly audit: InventoryAuditService,
    private readonly labor: LaborService,
  ) {}

  /**
   * A3. The key fences the whole command, and the claim is the first statement
   * inside the transaction that does the work.
   *
   * `quantity_moved` accumulates relatively and the movements are unconditional,
   * so a retried complete walks the same pallet twice — the one shape where a
   * status guard cannot save you, because a partial putaway leaves the task in
   * the same status it was in before.
   */
  async complete(
    orgId: string,
    userId: string,
    taskId: number,
    input: CompletePutawayInput,
    idempotencyKey: string,
  ): Promise<PutawayCompletionResult> {
    const result = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.putaway.complete", taskId, input },
        () => this.completeInTx(tx, orgId, userId, taskId, input, idempotencyKey),
        revivePutawayCompletion,
      ),
    );

    await this.engine.invalidateCaches(orgId);
    return result;
  }

  private async completeInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    taskId: number,
    input: CompletePutawayInput,
    idempotencyKey: string,
  ): Promise<PutawayCompletionResult> {
    const [task] = await tx.execute<TaskRow>(sql`
      SELECT id, status, warehouse_id, from_location_id, task_number, assigned_to
        FROM inv_putaway_tasks
       WHERE org_id = ${orgId} AND id = ${taskId}
       FOR UPDATE
    `);
    if (!task) throw new NotFoundException("Putaway task not found");
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, Number(task.warehouse_id));
    if (task.status === "COMPLETED")
      throw new ConflictException("This putaway task is already complete");
    if (task.status === "CANCELLED")
      throw new BadRequestException("A cancelled putaway task cannot be walked");
    if (task.assigned_to !== null && task.assigned_to !== userId)
      throw new ConflictException("Another operator is walking this task");

    const fromLocationId = Number(task.from_location_id);
    const warehouseId = Number(task.warehouse_id);
    const quarantineLocationId = await findQuarantineLocation(tx, orgId, warehouseId);

    const lines = await this.lockLines(tx, orgId, taskId, input);
    const planned = await this.planLines(tx, orgId, input, lines, {
      warehouseId,
      fromLocationId,
      quarantineLocationId,
    });

    const movements: StockMovement[] = [];
    for (const plan of planned) {
      const grain = {
        productVariantId: plan.line.product_variant_id,
        lotId: plan.line.lot_id ?? undefined,
        serialId: plan.line.serial_id ?? undefined,
      };
      // Emptied of its blocked quantity before it is emptied of its stock,
      // filled with its stock before it is filled with the blocked quantity
      // again. Either half in the other order leaves a bucket larger than the
      // on-hand it is a subset of.
      if (isPositive(plan.blockedCarry)) {
        movements.push({ transactionType: "QUARANTINE_OUT", ...grain, locationId: fromLocationId, quantityDelta: `-${plan.blockedCarry}`, qualityBucket: "BLOCKED" });
      }
      const issueIndex = movements.length;
      movements.push({ transactionType: "TRANSFER_OUT", ...grain, locationId: fromLocationId, quantityDelta: `-${plan.quantity}` });
      movements.push({ transactionType: "TRANSFER_IN", ...grain, locationId: plan.destinationId, quantityDelta: plan.quantity, costFromMovementIndex: issueIndex });
      if (isPositive(plan.blockedCarry)) {
        movements.push({ transactionType: "QUARANTINE_IN", ...grain, locationId: plan.destinationId, quantityDelta: plan.blockedCarry, qualityBucket: "BLOCKED" });
      }
    }

    // A derived key: claiming the command's own key twice in one transaction is
    // a duplicate, not a nesting, so passing it straight through would 409 every
    // first attempt.
    const engineResult = await this.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey: `${idempotencyKey}:stock`,
      sourceType: "inv_putaway_task",
      sourceId: String(taskId),
      reason: `Putaway: ${task.task_number}`,
      movements,
    });

    for (const plan of planned) {
      await tx
        .update(invPutawayTaskLines)
        .set({ quantityMoved: addDec(plan.line.quantity_moved, plan.quantity), toLocationId: plan.destinationId })
        .where(and(eq(invPutawayTaskLines.orgId, orgId), eq(invPutawayTaskLines.id, plan.line.id)));

      // NEO-7. Inside the command that finished the work, so a record cannot
      // exist for a putaway that rolled back. The destination is the bin the
      // operator walked to, which is what the distance proxy measures.
      await this.labor.recordInTx(tx, orgId, {
        warehouseId,
        taskKind: "PUTAWAY",
        taskId,
        taskLineId: plan.line.id,
        userId,
        locationId: plan.destinationId,
        unitsDone: plan.quantity,
        scanCount: 1,
      });
    }

    const [remaining] = await tx.execute<{ open: number }>(sql`
      SELECT COUNT(*)::int AS open
        FROM inv_putaway_task_lines
       WHERE org_id = ${orgId} AND task_id = ${taskId} AND quantity_moved < quantity
    `);
    const status = Number(remaining?.open ?? 0) === 0 ? "COMPLETED" : "IN_PROGRESS";

    await tx.execute(sql`
      UPDATE inv_putaway_tasks
         SET status = ${status}::inv_putaway_status,
             completed_at = CASE WHEN ${status} = 'COMPLETED' THEN NOW() ELSE completed_at END,
             assigned_to = COALESCE(assigned_to, ${userId}),
             claimed_at = COALESCE(claimed_at, NOW()),
             updated_at = NOW()
       WHERE org_id = ${orgId} AND id = ${taskId}
    `);

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "inventory.putaway.completed",
      resourceType: "inv_putaway_tasks",
      resourceId: String(taskId),
      before: { status: task.status },
      after: { status },
      metadata: {
        taskNumber: task.task_number,
        lineCount: planned.length,
        movementCount: movements.length,
        transactionIds: engineResult.transactionIds,
      },
    });

    // `outgoing_qty` is derived, and this command changed which grain the stock
    // stands at — the term is keyed on location, so both ends have to be
    // recomputed. Last, and in the same transaction as everything it reads: the
    // recompute must see the ledger after the movements, never before.
    for (const plan of planned) {
      const grain = {
        productVariantId: plan.line.product_variant_id,
        lotId: plan.line.lot_id,
        serialId: plan.line.serial_id,
      };
      await this.projection.syncOutgoing(tx, orgId, { ...grain, locationId: fromLocationId });
      await this.projection.syncOutgoing(tx, orgId, { ...grain, locationId: plan.destinationId });
    }

    return {
      taskId,
      status,
      lines: planned.map((plan) => ({
        taskLineId: plan.line.id,
        quantityMoved: addDec(plan.line.quantity_moved, plan.quantity),
        toLocationId: plan.destinationId,
      })),
      transactionIds: engineResult.transactionIds,
    };
  }

  /** The task's own lines, locked, so two partial completes cannot both read the same remainder. */
  private async lockLines(
    tx: Tx,
    orgId: string,
    taskId: number,
    input: CompletePutawayInput,
  ): Promise<Map<number, LineRow>> {
    const ids = [...new Set(input.lines.map((l) => l.taskLineId))];
    if (ids.length !== input.lines.length)
      throw new BadRequestException("A putaway line may only be confirmed once per request");

    const rows = await tx.execute<LineRow>(sql`
      SELECT id, product_variant_id, lot_id, serial_id,
             quantity::text AS quantity, quantity_moved::text AS quantity_moved,
             disposition::text AS disposition, to_location_id
        FROM inv_putaway_task_lines
       WHERE org_id = ${orgId}
         AND task_id = ${taskId}
         AND id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
       ORDER BY id
       FOR UPDATE
    `);

    const byId = new Map<number, LineRow>();
    for (const row of rows) byId.set(Number(row.id), row);
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0)
      throw new BadRequestException(`No such line on this task: ${missing.join(", ")}`);
    return byId;
  }

  /**
   * Resolves every line's destination and the quantities that travel with it,
   * before a single movement is built.
   *
   * Two passes rather than one because the source levels are locked in one
   * ordered statement — the same order the engine will use — so two concurrent
   * putaways over the same grains cannot take the rows in opposite order and
   * deadlock, and the bucket quantities this reads cannot change underneath the
   * movements that carry them.
   */
  private async planLines(
    tx: Tx,
    orgId: string,
    input: CompletePutawayInput,
    lines: Map<number, LineRow>,
    context: { warehouseId: number; fromLocationId: number; quarantineLocationId: number | null },
  ): Promise<PlannedLine[]> {
    const resolved: Array<{ line: LineRow; destinationId: number; quantity: string }> = [];

    for (const requested of input.lines) {
      const line = lines.get(requested.taskLineId)!;
      const remaining = subDec(line.quantity, line.quantity_moved);
      if (cmpDec(requested.quantity, remaining) > 0) {
        throw new BadRequestException(
          `Line ${line.id}: putting away ${requested.quantity} would exceed the ${remaining} still to move`,
        );
      }

      const disposition = line.disposition === "QUARANTINE" ? "QUARANTINE" : "STORAGE";
      // What the operator confirmed wins over what the line suggested, on both
      // dispositions — including a QUARANTINE line, where it is then refused
      // below rather than silently corrected. Quietly redirecting a scan to the
      // quarantine bin would leave the operator believing the goods are on
      // AISLE1 and the system believing they are not, which is worse than the
      // wrong scan it was trying to fix.
      const destinationId =
        requested.toLocationId ??
        (disposition === "QUARANTINE" ? context.quarantineLocationId : null) ??
        line.to_location_id;
      if (destinationId === null || destinationId === undefined) {
        throw new BadRequestException(
          `Line ${line.id}: no destination location — confirm where these goods went`,
        );
      }
      await assertDestinationUsable(tx, orgId, destinationId, {
        warehouseId: context.warehouseId,
        fromLocationId: context.fromLocationId,
        disposition,
        quarantineLocationId: context.quarantineLocationId,
      });

      resolved.push({ line, destinationId, quantity: requested.quantity });
    }

    // NEO-4. A putaway task moves loose stock; moving a handling unit is
    // `HandlingUnitService.move`, which re-keys the whole unit in one command
    // rather than line by line. Explicit null rather than omitted, so this reads
    // as a decision instead of an oversight.
    const grains: LevelGrain[] = resolved.flatMap((plan) => [
      { productVariantId: plan.line.product_variant_id, locationId: context.fromLocationId, lotId: plan.line.lot_id, serialId: plan.line.serial_id, handlingUnitId: null, ownership: "OWNED" },
      { productVariantId: plan.line.product_variant_id, locationId: plan.destinationId, lotId: plan.line.lot_id, serialId: plan.line.serial_id, handlingUnitId: null, ownership: "OWNED" },
    ]);
    const locked = await lockLevels(tx, orgId, grains);

    return resolved.map((plan) => {
      const source = locked.get(
        levelKey({
          productVariantId: plan.line.product_variant_id,
          locationId: context.fromLocationId,
          lotId: plan.line.lot_id,
          serialId: plan.line.serial_id,
          handlingUnitId: null,
          ownership: "OWNED",
        }),
      );
      // A reservation holds units *at a location*, so putting them away moves
      // the goods out from under it and the holder is left pointing at an empty
      // bin. Releasing it here would be a silent decision about somebody else's
      // order, so this refuses instead and says what clears it.
      if (source && isPositive(source.committed)) {
        throw new BadRequestException(
          `Line ${plan.line.id}: these units are reserved where they stand; release the reservation before putting them away`,
        );
      }
      // See the class comment: a hold's own row names where its units stand, and
      // that row belongs to Quality. Refusing is the honest answer; carrying the
      // bucket and leaving the pointer behind would make the hold unreleasable.
      if (source && isPositive(source.qualityHoldQty)) {
        throw new BadRequestException(
          `Line ${plan.line.id}: these units are on quality hold; release or disposition the hold before putting them away`,
        );
      }
      return { ...plan, blockedCarry: minDec(source?.blockedQty ?? "0", plan.quantity) };
    });
  }
}
