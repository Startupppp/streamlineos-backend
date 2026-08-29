import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invGrns, invPutawayTasks, invPutawayTaskLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { PutawayService, type PutawaySuggestion } from "../warehouses/putaway.service";
import { subDec } from "../stock-engine/decimal";
import { findQuarantineLocation } from "./putaway-destination";
import { readReceiptGrains } from "./putaway-receipt-grains";
import { queryPutawayQueue, type PutawayTaskLineRow } from "./putaway-task-queue";
import type {
  CreatePutawayTaskInput,
  ListPutawayTasksInput,
} from "./dto/putaway.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A line as the workbench renders it: what is left, and where it could go. */
export interface PutawayTaskLineView extends PutawayTaskLineRow {
  /** `quantity − quantity_moved`, exact. Item 4: never `Number()` on an 18,4 numeric. */
  remaining: string;
  suggestions: PutawaySuggestion[];
}

@Injectable()
export class PutawayTaskService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly numSeq: NumberSequenceService,
    private readonly suggestions: PutawayService,
    private readonly audit: InventoryAuditService,
  ) {}

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
  async createFromReceipt(
    orgId: string,
    userId: string,
    input: CreatePutawayTaskInput,
  ): Promise<{
    taskId: number;
    taskNumber: string;
    lineCount: number;
    quarantineLineCount: number;
  }> {
    const grn = await this.db.query.invGrns.findFirst({
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
    await this.warehouseScope.assertLocationVisible(orgId, userId, fromLocationId);

    const [location] = await this.db.execute<{ warehouse_id: number }>(sql`
      SELECT warehouse_id FROM inv_locations
       WHERE org_id = ${orgId} AND id = ${fromLocationId} LIMIT 1
    `);
    if (!location) throw new BadRequestException("The receiving location no longer exists");
    const warehouseId = Number(location.warehouse_id);

    const grains = await readReceiptGrains(this.db, orgId, input.grnId, fromLocationId);
    if (grains.length === 0) {
      throw new BadRequestException(
        "This goods receipt left no stock at its receiving location",
      );
    }

    const quarantineLocationId = await findQuarantineLocation(this.db, orgId, warehouseId);
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
      const options = await this.suggestions.suggest(orgId, userId, {
        warehouseId,
        productVariantId: grain.productVariantId,
        quantity: grain.quantity,
      });
      const best = options.find((o) => o.fits && o.locationId !== fromLocationId);
      suggested.set(grain.productVariantId, best?.locationId ?? null);
    }

    const taskNumber = await this.numSeq.next(orgId, "PUTAWAY");

    const created = await this.db.transaction(async (tx) => {
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

      await this.audit.insert(tx, {
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

  /** The workbench queue. Warehouse-scoped like every other inventory list. */
  async list(orgId: string, userId: string, filters: ListPutawayTasksInput) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return queryPutawayQueue(this.db, orgId, userId, filters, (column) =>
      this.warehouseScope.warehousePredicate(scope, column),
    );
  }

  /**
   * One task, in the order an operator should walk it.
   *
   * Suggestions ride along with each line rather than sitting behind a second
   * endpoint, because the decision the operator is making — which bin — is the
   * whole content of this screen, and a list that renders and then fills itself
   * in is a list the operator scrolls past. One suggestion query per distinct
   * variant, not per line: two lots of one SKU ask the same question.
   */
  async get(
    orgId: string,
    userId: string,
    taskId: number,
  ): Promise<{
    task: typeof invPutawayTasks.$inferSelect;
    lines: PutawayTaskLineView[];
  }> {
    const task = await this.assertVisible(orgId, userId, taskId);
    const lines = await this.lineRows(this.db, orgId, taskId);

    const byVariant = new Map<number, PutawaySuggestion[]>();
    for (const line of lines) {
      if (line.disposition === "QUARANTINE") continue;
      if (byVariant.has(line.product_variant_id)) continue;
      byVariant.set(
        line.product_variant_id,
        await this.suggestions.suggest(orgId, userId, {
          warehouseId: task.warehouseId,
          productVariantId: line.product_variant_id,
          quantity: subDec(line.quantity, line.quantity_moved),
        }),
      );
    }

    return {
      task,
      lines: lines.map((line) => ({
        ...line,
        remaining: subDec(line.quantity, line.quantity_moved),
        suggestions: (byVariant.get(line.product_variant_id) ?? []).filter(
          (s) => s.locationId !== task.fromLocationId,
        ),
      })),
    };
  }

  /**
   * B3, item 1 — claim, abandon, cancel.
   *
   * All three are conditional single statements, which is what makes them safe
   * to retry and impossible to double-count. None of them touches a quantity, so
   * no repetition of any of them can move stock, and none takes an idempotency
   * key: a key that fences nothing is worse than no key, because the client
   * believes it is protected.
   */
  async claim(orgId: string, userId: string, taskId: number) {
    const task = await this.assertVisible(orgId, userId, taskId);
    this.assertOpen(task.status);

    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: number }>(sql`
        UPDATE inv_putaway_tasks
           SET assigned_to = ${userId}, claimed_at = NOW(),
               status = CASE WHEN status = 'PENDING' THEN 'IN_PROGRESS'::inv_putaway_status ELSE status END,
               updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${taskId} AND assigned_to IS NULL
        RETURNING id
      `);
      if (rows.length > 0) {
        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "inventory.putaway.task_claimed",
          resourceType: "inv_putaway_tasks",
          resourceId: String(taskId),
          after: { assignedTo: userId },
        });
      }
      return rows.length > 0;
    });

    // A claim the caller already holds is not a failure: retrying one is exactly
    // what a flaky warehouse network produces.
    if (!claimed && task.assignedTo !== userId) {
      throw new ConflictException("Another operator is already walking this task");
    }

    return { taskId, assignedTo: userId, claimed };
  }

  async abandon(orgId: string, userId: string, taskId: number) {
    const task = await this.assertVisible(orgId, userId, taskId);
    if (task.assignedTo !== null && task.assignedTo !== userId) {
      throw new ConflictException("Another operator is walking this task");
    }

    const released = await this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: number }>(sql`
        UPDATE inv_putaway_tasks
           SET assigned_to = NULL, claimed_at = NULL, updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${taskId} AND assigned_to = ${userId}
        RETURNING id
      `);
      if (rows.length > 0) {
        await this.audit.insert(tx, {
          orgId,
          actorUserId: userId,
          action: "inventory.putaway.task_abandoned",
          resourceType: "inv_putaway_tasks",
          resourceId: String(taskId),
          before: { assignedTo: userId },
          after: { assignedTo: null },
        });
      }
      return rows.length > 0;
    });

    // What was already walked stays walked. Handing the task back gives up the
    // remaining lines, not the stock that has already moved — unwinding that is
    // a stock adjustment, and inventing one here would be a silent movement.
    return { taskId, assignedTo: null, released };
  }

  /**
   * Abandons the rest of the walk for good.
   *
   * A lifecycle with no terminal state but "finished" is a trap — a receipt
   * whose goods were dealt with some other way leaves a task in the queue
   * forever, and the queue stops being a list of work. Cancelling closes the
   * document and moves nothing: the lines already walked stay walked.
   */
  async cancel(orgId: string, userId: string, taskId: number) {
    const task = await this.assertVisible(orgId, userId, taskId);
    this.assertOpen(task.status);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE inv_putaway_tasks
           SET status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW()
         WHERE org_id = ${orgId} AND id = ${taskId} AND status <> 'COMPLETED'
      `);
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.putaway.task_cancelled",
        resourceType: "inv_putaway_tasks",
        resourceId: String(taskId),
        before: { status: task.status },
        after: { status: "CANCELLED" },
      });
      return { taskId, status: "CANCELLED" as const };
    });
  }

  private assertOpen(status: string): void {
    if (status === "COMPLETED" || status === "CANCELLED") {
      throw new BadRequestException("This putaway task is already finished");
    }
  }

  private async assertVisible(orgId: string, userId: string, taskId: number) {
    const task = await this.db.query.invPutawayTasks.findFirst({
      where: and(eq(invPutawayTasks.id, taskId), eq(invPutawayTasks.orgId, orgId)),
    });
    // 404 rather than 403 on another tenant's id: a 403 confirms the record
    // exists and turns a probe into an existence oracle.
    if (!task) throw new NotFoundException("Putaway task not found");
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, task.warehouseId);
    return task;
  }

  private lineRows(tx: Db | Tx, orgId: string, taskId: number) {
    return tx.execute<PutawayTaskLineRow>(sql`
      SELECT tl.id,
             tl.product_variant_id,
             v.sku,
             v.name AS variant_name,
             tl.lot_id,
             lot.lot_number,
             tl.serial_id,
             ser.serial_number,
             tl.quantity::text AS quantity,
             tl.quantity_moved::text AS quantity_moved,
             tl.disposition::text AS disposition,
             tl.to_location_id,
             dest.code AS to_location_code
        FROM inv_putaway_task_lines tl
        JOIN inv_product_variants v
          ON v.org_id = tl.org_id AND v.id = tl.product_variant_id
        LEFT JOIN inv_lots lot
          ON lot.org_id = tl.org_id AND lot.id = tl.lot_id
        LEFT JOIN inv_serial_numbers ser
          ON ser.org_id = tl.org_id AND ser.id = tl.serial_id
        LEFT JOIN inv_locations dest
          ON dest.org_id = tl.org_id AND dest.id = tl.to_location_id
       WHERE tl.org_id = ${orgId} AND tl.task_id = ${taskId}
       ORDER BY dest.code NULLS LAST, tl.id
    `);
  }
}
