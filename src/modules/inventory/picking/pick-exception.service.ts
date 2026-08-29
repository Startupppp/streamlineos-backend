import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { PickCompletionService } from "./pick-completion.service";
import { queryPickExceptionQueue } from "./pick-exception-queue";
import type {
  AssignPickExceptionInput,
  ListPickExceptionsInput,
  ResolvePickExceptionInput,
} from "./dto/picking.schemas";

interface ExceptionRow {
  pickLineId: number;
  pickListId: number;
  warehouseId: number | null;
  reason: string;
  status: string;
  ownerId: string | null;
}

/**
 * B5, items 2 and 4 — an exception's own life, after the picker has walked away.
 *
 * Raising one is picking's business and lives in `PickConfirmService`, beside the
 * reservation arithmetic it has to get right. What happens to it afterwards is a
 * different job with a different audience and a different permission: a
 * supervisor reading a queue, taking ownership, and signing a decision. Keeping
 * the two apart is what lets `inventory:sales-orders:ship` stay the picker's key
 * and `inventory:picking:review` be the reviewer's.
 */
@Injectable()
export class PickExceptionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly completion: PickCompletionService,
    private readonly audit: InventoryAuditService,
  ) {}

  /** The queue, warehouse-scoped like every other inventory list. */
  async list(orgId: string, userId: string, filters: ListPickExceptionsInput) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return queryPickExceptionQueue(this.db, orgId, userId, filters, (column) =>
      this.warehouseScope.warehousePredicate(scope, column),
    );
  }

  /**
   * Hands an exception to the person who will actually deal with it.
   *
   * A conditional single statement against the current owner, so it needs no
   * idempotency key: repeating it is the same state rather than a second effect,
   * and a key implying a fence this does not need is worse than none, because
   * the client believes it is protected.
   */
  async assign(
    orgId: string,
    userId: string,
    pickLineId: number,
    input: AssignPickExceptionInput,
  ) {
    const line = await this.loadException(orgId, userId, pickLineId);

    const [member] = await this.db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM organization_members
       WHERE org_id = ${orgId} AND user_id = ${input.ownerUserId} AND status = 'ACTIVE'
    `);
    // 404 rather than 403: a caller learning that a given user id exists in some
    // other organisation is an existence oracle.
    if (!member) {
      throw new NotFoundException("That person is not a member of this organisation");
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE inv_pick_list_lines
           SET exception_owner_id = ${input.ownerUserId}
         WHERE org_id = ${orgId} AND id = ${pickLineId} AND exception_reason IS NOT NULL
      `);
      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.pick.exception_assigned",
        resourceType: "inv_pick_list_lines",
        resourceId: String(pickLineId),
        before: { exceptionOwnerId: line.ownerId },
        after: { exceptionOwnerId: input.ownerUserId },
        metadata: { pickListId: line.pickListId, reason: line.reason },
      });
      return { pickLineId, ownerUserId: input.ownerUserId };
    });
  }

  /**
   * B5, item 4 — the supervisor's signature.
   *
   * **What resolving does, and what it deliberately does not.** It records a
   * judgement, and it unblocks the wave: a damaged or substituted line stays
   * open until somebody has looked at it (`PICK_LINE_CLOSED_SQL`), which is what
   * "unresolved can block wave complete where required" means, and this is the
   * act that ends the block.
   *
   * It moves no stock, in either direction, and that is a decision rather than an
   * omission. By the time a reviewer sees the row the goods have already been
   * taken off a shelf or found broken — the reservation arithmetic was settled
   * when the exception was raised, in the same transaction, against what was
   * physically true. `REJECTED` therefore means "we do not accept this report",
   * not "undo it": putting toted goods back on a shelf is a physical act with its
   * own document, and inventing one from a review screen is the same silent stock
   * movement `abandonWave` refuses to make. What it changes is what a human does
   * next, which is exactly what a review is for.
   *
   * The wave still closes on a rejection. The picker has physically finished
   * walking; holding a whole warehouse's walk open on one disputed line helps
   * nobody, and the rejected row stays in the queue with its note.
   *
   * Conditional on the exception still being OPEN, so a second reviewer racing
   * the first is told the decision was already taken rather than quietly
   * overwriting it.
   */
  async resolve(
    orgId: string,
    userId: string,
    pickLineId: number,
    input: ResolvePickExceptionInput,
  ) {
    const line = await this.loadException(orgId, userId, pickLineId);
    if (line.status !== "OPEN") {
      throw new BadRequestException("This exception has already been reviewed");
    }

    return this.db.transaction(async (tx) => {
      const updated = await tx.execute<{ id: number }>(sql`
        UPDATE inv_pick_list_lines
           SET exception_status = 'RESOLVED',
               exception_resolution = ${input.resolution},
               exception_resolution_notes = ${input.notes},
               exception_resolved_by = ${userId},
               exception_resolved_at = NOW()
         WHERE org_id = ${orgId}
           AND id = ${pickLineId}
           AND exception_reason IS NOT NULL
           AND exception_status = 'OPEN'
        RETURNING id
      `);
      if (updated.length === 0) {
        throw new BadRequestException("This exception has already been reviewed");
      }

      // The wave may have been waiting on exactly this signature.
      const waveComplete = await this.completion.finishWave(
        tx,
        orgId,
        userId,
        line.pickListId,
      );

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "inventory.pick.exception_resolved",
        resourceType: "inv_pick_list_lines",
        resourceId: String(pickLineId),
        before: { exceptionStatus: "OPEN" },
        after: { exceptionStatus: "RESOLVED", exceptionResolution: input.resolution },
        metadata: {
          pickListId: line.pickListId,
          reason: line.reason,
          notes: input.notes,
          waveComplete,
        },
      });

      return {
        pickLineId,
        status: "RESOLVED" as const,
        resolution: input.resolution,
        resolvedBy: userId,
        waveComplete,
      };
    });
  }

  /**
   * Object-level authorization for a single exception: the tenant, and the
   * warehouse its wave belongs to. Both re-asserted on every call rather than
   * inferred from the fact that the caller holds the review key — module ability
   * says nothing about *this* row.
   */
  private async loadException(
    orgId: string,
    userId: string,
    pickLineId: number,
  ): Promise<ExceptionRow> {
    const [row] = await this.db.execute<{
      pick_line_id: number;
      pick_list_id: number;
      warehouse_id: number | null;
      reason: string | null;
      status: string | null;
      owner_id: string | null;
    }>(sql`
      SELECT pll.id AS pick_line_id,
             pll.pick_list_id,
             pl.warehouse_id,
             pll.exception_reason AS reason,
             pll.exception_status AS status,
             pll.exception_owner_id AS owner_id
        FROM inv_pick_list_lines pll
        JOIN inv_pick_lists pl
          ON pl.org_id = pll.org_id AND pl.id = pll.pick_list_id
       WHERE pll.org_id = ${orgId} AND pll.id = ${pickLineId}
    `);
    if (!row || row.reason === null) {
      throw new NotFoundException("No exception on that pick line");
    }
    const warehouseId = row.warehouse_id === null ? null : Number(row.warehouse_id);
    if (warehouseId !== null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId);
    }
    return {
      pickLineId: Number(row.pick_line_id),
      pickListId: Number(row.pick_list_id),
      warehouseId,
      reason: row.reason,
      status: row.status ?? "OPEN",
      ownerId: row.owner_id,
    };
  }
}
