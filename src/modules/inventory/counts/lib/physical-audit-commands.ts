import { BadRequestException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invPhysicalAudits, invPhysicalAuditLines } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../../stock-engine/stock-engine.service";
import { StockMovementBridgeService } from "../../../accounting/adapters/stock-movement-bridge.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { buildCountVarianceMovements } from "../count-variance-movements";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../../stock-engine/command-events";
import type { CreateAuditInput, UpdateCountLinesInput } from "../dto/inv-counts.schemas";

/**
 * What `requireAudit` hands back — the four columns the commands gate on.
 *
 * Spelled out rather than inferred because that read stays on the service (it
 * is the one that resolves the caller's warehouse scope) and reaches this file
 * as a callback. A callback needs a return type.
 */
export interface GatedAudit {
  readonly id: number;
  readonly status: string;
  readonly auditNumber: string;
  readonly warehouseId: number;
}

/**
 * The six commands of a physical audit: open it, start it, count into it,
 * review it, post the variance, or cancel.
 *
 * Split from the reads next door because the reads are what gate them —
 * `requireAudit` resolves the caller's warehouse scope and `loadAuditUnscoped`
 * skips it. Both reach this file as CALLBACKS rather than imports:
 * `loadAuditUnscoped` is the ungated read, pinned by
 * `__tests__/physical-audit-scope.spec.ts` as a named private method so a
 * future route cannot be pointed at it by accident, and exporting it from
 * `lib/` would undo that. Every command here ends by returning the audit it
 * just changed, and the caller's standing was settled before it ran.
 */
export interface PhysicalAuditDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly engine: StockEngineService;
  readonly numSeq: NumberSequenceService;
  readonly warehouseScope: WarehouseScopeService;
  /** ACC-21. The variance posts to the general ledger on the audit's own transaction. */
  readonly glBridge: StockMovementBridgeService;
  readonly requireAudit: (orgId: string, userId: string, auditId: number) => Promise<GatedAudit>;
  readonly reloadUnscopedAudit: (orgId: string, auditId: number) => Promise<unknown>;
}

export const PA_LIST_NAMESPACE = (orgId: string) => `inv:physical-audits:list:${orgId}`;
export const PA_DETAIL_KEY = (orgId: string, id: number) => `inv:physical-audits:detail:${orgId}:${id}`;

export async function createAudit(
  deps: PhysicalAuditDeps,orgId: string, userId: string, data: CreateAuditInput) {
  // The warehouse is the caller's claim, straight off the body. Ungated, a
  // planner scoped to one building could open an audit of another and have
  // every stock level in it copied into the audit lines and returned — the
  // detail-read disclosure, reached through the create instead.
  await deps.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);

  const auditNumber = await deps.numSeq.next(orgId, "PHYSICAL_AUDIT");

  const [audit] = await deps.db.insert(invPhysicalAudits).values({
    orgId,
    auditNumber,
    warehouseId: data.warehouseId,
    status: "PLANNED",
    createdBy: userId,
  }).returning();

  const stockLevels = await deps.db.execute<{
    product_variant_id: number; location_id: number; lot_id: number | null; on_hand: string;
  }>(sql`
    SELECT sl.product_variant_id, sl.location_id, sl.lot_id, sl.on_hand
    FROM inv_stock_levels sl
    JOIN inv_locations loc ON loc.id = sl.location_id
    WHERE sl.org_id = ${orgId} AND loc.warehouse_id = ${data.warehouseId}
  `);

  if (stockLevels.length > 0) {
    await deps.db.insert(invPhysicalAuditLines).values(
      stockLevels.map((row) => ({
        orgId,
        auditId: audit.id,
        productVariantId: row.product_variant_id,
        locationId: row.location_id,
        lotId: row.lot_id ?? null,
        systemQty: row.on_hand,
      }))
    );
  }

  await deps.cache.invalidateNamespace(PA_LIST_NAMESPACE(orgId));
  return deps.reloadUnscopedAudit(orgId, audit.id);
}

export async function startAudit(
  deps: PhysicalAuditDeps,orgId: string, userId: string, auditId: number) {
  const audit = await deps.requireAudit(orgId, userId, auditId);
  if (audit.status !== "PLANNED") throw new BadRequestException("Only PLANNED audits can be started");

  await deps.db.update(invPhysicalAudits)
    .set({ status: "COUNTING" })
    .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

  await deps.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
  return deps.reloadUnscopedAudit(orgId, auditId);
}

export async function updateLines(
  deps: PhysicalAuditDeps,orgId: string, userId: string, auditId: number, data: UpdateCountLinesInput) {
  const audit = await deps.requireAudit(orgId, userId, auditId);
  if (audit.status !== "COUNTING") throw new BadRequestException("Lines can only be updated while status is COUNTING");

  if (data.lines.length > 0) {
    // Same untyped-parameter defect as the cycle-count path: a bound value in
    // a `VALUES` list is `text` until it is cast, so the join to an `integer`
    // id failed outright and no audit line could ever record what was counted.
    const values = sql.join(
      data.lines.map(
        (update) => sql`(${update.lineId}::int, ${update.countedQty.toFixed(4)}::numeric)`,
      ),
      sql`, `,
    );
    await deps.db.execute(sql`
      UPDATE ${invPhysicalAuditLines}
      SET counted_qty = updates.counted_qty
      FROM (VALUES ${values}) AS updates(id, counted_qty)
      WHERE ${invPhysicalAuditLines.id} = updates.id
        AND ${invPhysicalAuditLines.auditId} = ${auditId}
    `);
  }

  await deps.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
  return deps.reloadUnscopedAudit(orgId, auditId);
}

export async function reviewAudit(
  deps: PhysicalAuditDeps,orgId: string, userId: string, auditId: number) {
  const audit = await deps.requireAudit(orgId, userId, auditId);
  if (audit.status !== "COUNTING") throw new BadRequestException("Only COUNTING audits can move to REVIEW");

  await deps.db
    .update(invPhysicalAuditLines)
    .set({
      varianceQty: sql`coalesce(${invPhysicalAuditLines.countedQty}, 0) - ${invPhysicalAuditLines.systemQty}`,
    })
    .where(eq(invPhysicalAuditLines.auditId, auditId));

  await deps.db.update(invPhysicalAudits)
    .set({ status: "REVIEW" })
    .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

  await deps.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
  return deps.reloadUnscopedAudit(orgId, auditId);
}

export async function postAudit(
  deps: PhysicalAuditDeps,orgId: string, userId: string, auditId: number, idempotencyKey: string) {
  const audit = await deps.requireAudit(orgId, userId, auditId);
  if (audit.status !== "REVIEW") throw new BadRequestException("Only REVIEW audits can be posted");

  // Same grain rule as the cycle count: the audit line records the lot its
  // `systemQty` was read from, so the correction has to name it or it lands
  // on a different level than the one that was counted.
  const lines = await deps.db.query.invPhysicalAuditLines.findMany({
    where: eq(invPhysicalAuditLines.auditId, auditId),
    columns: { productVariantId: true, locationId: true, lotId: true, varianceQty: true },
  });

  const movements = buildCountVarianceMovements(lines);

  /*
    One transaction for the status, the movements, the ledger and the event.

    ACC-21. It was two: `engine.execute` opened its own transaction and the
    status flip ran after it, so a crash in between left stock moved with the
    audit still at REVIEW — the defect B1-05/B1-11 fixed for adjustments. The
    general-ledger post has to ride the movement's transaction anyway
    (`docs/inventory-gl-contract.md` §3.3/§4), so the movements join the
    document's transaction rather than the other way round.

    A5. The event still shares the transaction with the flip, so it cannot
    survive a posting that rolled back.

    The guarded flip goes FIRST. It is what makes a second, concurrent post of
    the same audit under another key find nothing to do — and with the
    movements now inside the same transaction, "nothing to do" also means
    nothing moved, rather than stock moved twice and the status found already
    changed afterwards.
  */
  await deps.db.transaction(async (tx) => {
    const posted = await tx.update(invPhysicalAudits)
      .set({ status: "POSTED", postedAt: new Date(), approvedBy: userId })
      .where(and(
        eq(invPhysicalAudits.orgId, orgId),
        eq(invPhysicalAudits.id, auditId),
        eq(invPhysicalAudits.status, "REVIEW"),
      ))
      .returning({ id: invPhysicalAudits.id });

    if (posted.length === 0) return;

    if (movements.length > 0) {
      const moved = await deps.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_physical_audit",
        sourceId: auditId.toString(),
        reason: `Physical audit ${audit.auditNumber}`,
        movements,
      });

      await deps.glBridge.post(
        orgId,
        userId,
        {
          kind: "physical_audit",
          documentId: String(auditId),
          transactionIds: moved.transactionIds,
          journalDate: new Date().toISOString().slice(0, 10),
          memo: `Physical audit ${audit.auditNumber}`,
        },
        tx,
      );
    }

    await emitInventoryCommandEvent(tx, {
      orgId,
      eventType: INVENTORY_COMMAND_EVENTS.COUNT_POSTED,
      aggregateType: "inv_physical_audit",
      aggregateId: String(auditId),
      actorUserId: userId,
      payload: {
        countType: "PHYSICAL",
        countId: auditId,
        countNumber: audit.auditNumber,
        warehouseId: audit.warehouseId,
        lineCount: lines.length,
        varianceLineCount: movements.length,
        idempotencyKey,
      },
    });
  });

  // `engine.execute` invalidated the stock caches after its own commit;
  // `executeInTx` leaves that to whoever owns the transaction.
  await deps.engine.invalidateCaches(orgId);
  await deps.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
  await deps.cache.invalidateNamespace(PA_LIST_NAMESPACE(orgId));
  return deps.reloadUnscopedAudit(orgId, auditId);
}

export async function cancelAudit(
  deps: PhysicalAuditDeps,orgId: string, userId: string, auditId: number) {
  const audit = await deps.requireAudit(orgId, userId, auditId);
  if (audit.status === "POSTED") throw new BadRequestException("Posted audits cannot be cancelled");

  await deps.db.update(invPhysicalAudits)
    .set({ status: "CANCELLED", cancelledAt: new Date() })
    .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

  await deps.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
}
