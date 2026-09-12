import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invPutawayTasks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { PutawayService } from "../warehouses/putaway.service";
import type { PutawaySuggestion } from "../warehouses/putaway-suggestion";
import { subDec } from "../stock-engine/decimal";
import { queryPutawayQueue, type PutawayTaskLineRow } from "./putaway-task-queue";
import {
  createFromReceipt,
  type PutawayTaskCreated,
  type PutawayTaskCreateDeps,
} from "./lib/putaway-task-create";
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

  private get createDeps(): PutawayTaskCreateDeps {
    return {
      db: this.db,
      warehouseScope: this.warehouseScope,
      numSeq: this.numSeq,
      suggestions: this.suggestions,
      audit: this.audit,
    };
  }

  /** B3, item 1 — raise the walk for a posted receipt. See `lib/putaway-task-create.ts`. */
  createFromReceipt(
    orgId: string,
    userId: string,
    input: CreatePutawayTaskInput,
  ): Promise<PutawayTaskCreated> {
    return createFromReceipt(this.createDeps, orgId, userId, input);
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
