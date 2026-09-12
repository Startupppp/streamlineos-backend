import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invGrns, invPutawayTasks, invPutawayTaskLines } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import type { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { PutawayService } from "../../warehouses/putaway.service";
import { findQuarantineLocation } from "../putaway-destination";
import { readReceiptGrains } from "../putaway-receipt-grains";
import type { CreatePutawayTaskInput } from "../dto/putaway.schemas";

/**
 * Raising a putaway task from a posted receipt — lifted out of
 * `putaway-task.service.ts` unchanged.
 *
 * The seam is the one B3's own doc (below) draws: raising the walk is "a second
 * command over the first one's result", reading a GOODS RECEIPT and producing a
 * task, while everything left in the service operates on a task that already
 * exists — `get`, `claim`, `abandon`, `cancel`, all gated through the service's
 * private `assertVisible` on the task row. This function never calls
 * `assertVisible`, `assertOpen` or `lineRows`, and none of them could apply: there
 * is no task yet. Its gate is on the receipt's receiving location instead, through
 * `WarehouseScopeService.assertLocationVisible`, which is a public method of that
 * service and so travels in the deps bag rather than being re-exported.
 *
 * It is also the only path in the file that reads `inv_grns`, asks the number
 * sequence for a document number, or calls the bin-suggestion service to CHOOSE
 * a destination (`get` calls it to display options on a task that exists).
 */
export interface PutawayTaskCreateDeps {
  readonly db: Db;
  readonly warehouseScope: WarehouseScopeService;
  readonly numSeq: NumberSequenceService;
  readonly suggestions: PutawayService;
  readonly audit: InventoryAuditService;
}

export interface PutawayTaskCreated {
  taskId: number;
  taskNumber: string;
  lineCount: number;
  quarantineLineCount: number;
}

/**
 * B3, item 1 — raise the walk for a receipt that has already landed.
 *
 * Owned here rather than bolted onto the receipt post, and that is a decision
 * rather than a convenience. A receipt that posted is a complete fact on its
 * own: the stock exists, it is countable, and it is valued. Making the putaway
 * part of that transaction would mean a warehouse with no storage bins
 * configured could not receive at all, and a putaway that failed would unwind a
 * delivery that had physically arrived. So the task is a second command over
 * the first one's result, and the two fail independently.
 *
 * One live task per receipt, enforced by a partial unique index rather than by
 * the check below: two operators pressing the button at once both pass a read,
 * and only the database can settle it. The check is there to say something
 * legible when it does.
 */
export async function createFromReceipt(
  deps: PutawayTaskCreateDeps,
  orgId: string,
  userId: string,
  input: CreatePutawayTaskInput,
): Promise<PutawayTaskCreated> {
  const grn = await deps.db.query.invGrns.findFirst({
    where: and(eq(invGrns.id, input.grnId), eq(invGrns.orgId, orgId)),
    columns: { id: true, status: true, locationId: true, grnNumber: true },
  });
  if (!grn) throw new NotFoundException("Goods receipt not found");
  if (grn.status !== "POSTED") {
    throw new BadRequestException(
      "Only a posted goods receipt has stock to put away",
    );
  }
  const fromLocationId = grn.locationId;
  if (fromLocationId === null) {
    throw new BadRequestException("This goods receipt has no receiving location");
  }
  await deps.warehouseScope.assertLocationVisible(orgId, userId, fromLocationId);

  const [location] = await deps.db.execute<{ warehouse_id: number }>(sql`
    SELECT warehouse_id FROM inv_locations
     WHERE org_id = ${orgId} AND id = ${fromLocationId} LIMIT 1
  `);
  if (!location) throw new BadRequestException("The receiving location no longer exists");
  const warehouseId = Number(location.warehouse_id);

  const grains = await readReceiptGrains(deps.db, orgId, input.grnId, fromLocationId);
  if (grains.length === 0) {
    throw new BadRequestException(
      "This goods receipt left no stock at its receiving location",
    );
  }

  const quarantineLocationId = await findQuarantineLocation(deps.db, orgId, warehouseId);
  const quarantined = grains.filter((g) => g.disposition === "QUARANTINE");
  if (quarantined.length > 0 && quarantineLocationId === null) {
    throw new BadRequestException(
      "These goods are quarantined and this warehouse has no quarantine location",
    );
  }

  // The suggestion is advisory and the operator may confirm another bin, so a
  // grain with nowhere obvious to go still produces a line: a task the
  // warehouse has to think about beats no task at all.
  const suggested = new Map<number, number | null>();
  for (const grain of grains) {
    if (grain.disposition === "QUARANTINE") continue;
    if (suggested.has(grain.productVariantId)) continue;
    const options = await deps.suggestions.suggest(orgId, userId, {
      warehouseId,
      productVariantId: grain.productVariantId,
      quantity: grain.quantity,
    });
    const best = options.find((o) => o.fits && o.locationId !== fromLocationId);
    suggested.set(grain.productVariantId, best?.locationId ?? null);
  }

  const taskNumber = await deps.numSeq.next(orgId, "PUTAWAY");

  const created = await deps.db.transaction(async (tx) => {
    const [task] = await tx
      .insert(invPutawayTasks)
      .values({
        orgId,
        taskNumber,
        warehouseId,
        grnId: input.grnId,
        fromLocationId,
        status: "PENDING",
        createdBy: userId,
      })
      .returning({ id: invPutawayTasks.id });
    if (!task) throw new ConflictException("Could not raise the putaway task");

    await tx.insert(invPutawayTaskLines).values(
      grains.map((grain) => ({
        orgId,
        taskId: task.id,
        productVariantId: grain.productVariantId,
        lotId: grain.lotId,
        serialId: grain.serialId,
        quantity: grain.quantity,
        quantityMoved: "0",
        disposition: grain.disposition,
        toLocationId:
          grain.disposition === "QUARANTINE"
            ? quarantineLocationId
            : (suggested.get(grain.productVariantId) ?? null),
      })),
    );

    await deps.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "inventory.putaway.task_created",
      resourceType: "inv_putaway_tasks",
      resourceId: String(task.id),
      after: { taskNumber, grnId: input.grnId, fromLocationId },
      metadata: { lineCount: grains.length, quarantineLineCount: quarantined.length },
    });

    return task.id;
  });

  return {
    taskId: created,
    taskNumber,
    lineCount: grains.length,
    quarantineLineCount: quarantined.length,
  };
}
