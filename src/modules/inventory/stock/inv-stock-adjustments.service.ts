import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  invStockAdjustments, invStockAdjustmentLines,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { CostVisibilityService } from "../stock-engine/cost-visibility";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { ListAdjustmentsInput, CreateAdjustmentInput } from "./dto/inv-stock.schemas";
import { loadCorrectableVariants } from "../products/lib/orderable-variants";
import {
  WRITE_OFF_REASONS,
  adjustmentMovementType,
  assertWriteOffRemovesStock,
  isWriteOffReason,
  withoutWriteOffValue,
} from "./lib/write-off";
import {
  needsApproval as adjustmentNeedsApproval,
  resolveScrapLocation,
} from "./lib/adjustment-approval";
import { sqlstateOf } from "../../../common/observability/error-classification";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The document as the posting path needs it. */
interface PostableAdjustment {
  id: number;
  referenceNumber: string;
  reason: string;
  notes: string | null;
  scrapLocationId: number | null;
  lines: Array<{ productVariantId: number; locationId: number; quantityChange: string }>;
}

@Injectable()
export class InvStockAdjustmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly settings: InventorySettingsService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly costVisibility: CostVisibilityService,
  ) {}

  async listAdjustments(orgId: string, filters: ListAdjustmentsInput, scope: DataScope = "all", userId?: string) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, reason, writeOffsOnly, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invStockAdjustments.orgId, orgId)];
    if (status) conditions.push(eq(invStockAdjustments.status, status));
    if (reason) conditions.push(eq(invStockAdjustments.reason, reason));
    // D8. The write-off queue is one predicate over the reason, not a second
    // table to keep in step with this one.
    if (writeOffsOnly) conditions.push(inArray(invStockAdjustments.reason, [...WRITE_OFF_REASONS]));
    if (scope !== "all" && userId) {
      conditions.push(applyScope(scope, orgId, userId, { ownerColumn: invStockAdjustments.createdBy }));
    }
    if (userId) {
      // Locations live on the lines, not the header, so scope via EXISTS.
      const warehouses = await this.warehouseScope.resolve(orgId, userId);
      if (warehouses !== null) {
        const ids = this.warehouseScope.warehouseIdList(warehouses);
        conditions.push(ids === null ? sql`FALSE` : sql`EXISTS (
          SELECT 1 FROM inv_stock_adjustment_lines l
          JOIN inv_locations loc ON loc.id = l.location_id
          WHERE l.adjustment_id = ${invStockAdjustments.id} AND loc.warehouse_id IN (${ids})
        )`);
      }
    }
    const where = and(...conditions);

    const [items, countResult] = await Promise.all([
      this.db.query.invStockAdjustments.findMany({
        where,
        orderBy: [desc(invStockAdjustments.createdAt)],
        limit,
        offset,
        with: {
          creator: { columns: { id: true, name: true } },
          approver: { columns: { id: true, name: true } },
          poster: { columns: { id: true, name: true } },
          lines: true,
        },
      }),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invStockAdjustments).where(where),
    ]);

    const showCost = userId !== undefined && (await this.costVisibility.canSeeCost(orgId, userId));
    return {
      items: showCost ? items : items.map(withoutWriteOffValue),
      total: countResult[0]?.count ?? 0,
      page,
      totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
    };
  }

  async getAdjustment(orgId: string, adjustmentId: number, userId?: string) {
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      with: {
        creator: { columns: { id: true, name: true } },
        approver: { columns: { id: true, name: true } },
        poster: { columns: { id: true, name: true } },
        scrapLocation: { columns: { id: true, name: true, code: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            location: { columns: { id: true, name: true, code: true } },
          },
        },
      },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    const showCost = userId !== undefined && (await this.costVisibility.canSeeCost(orgId, userId));
    return showCost ? adj : withoutWriteOffValue(adj);
  }

  /**
   * A3. The key reached this method and only one of its two branches used it.
   *
   * Below the approval threshold the adjustment posts immediately and the key
   * went to the engine, so the *movement* was protected. Above it the command
   * stopped at PENDING_APPROVAL and claimed nothing at all — a retried create
   * raised a second adjustment document with its own reference number and its
   * own lines, and both of them were then approvable and postable. That is the
   * write-off path, where a duplicate is not a cosmetic problem.
   *
   * The claim therefore wraps the whole command rather than the posting half of
   * it, and the engine is given a derived key: the same key claimed twice in
   * one transaction is a duplicate, not a nesting.
   */
  async createAdjustment(orgId: string, userId: string, data: CreateAdjustmentInput, idempotencyKey: string) {
    // A4. The correction gate, not the demand gate: writing off or recounting a
    // discontinued SKU is exactly what an operator does with retired stock, so
    // only a product deleted from the catalogue is refused here.
    const variants = await loadCorrectableVariants(this.db, orgId, data.lines.map((l) => l.productVariantId));

    // D8. A write-off is an adjustment with a condemning reason, so the two
    // rules that only make sense for one are asserted for one.
    const writeOff = isWriteOffReason(data.reason);
    if (writeOff) assertWriteOffRemovesStock(data.reason, data.lines);
    else if (data.scrapLocationId !== undefined) {
      throw new BadRequestException(
        `A scrap location only applies to a write-off (${WRITE_OFF_REASONS.join(", ")}), not to a ${data.reason} adjustment`,
      );
    }
    const scrapLocationId = writeOff
      ? await resolveScrapLocation(this.db, orgId, data.lines, data.scrapLocationId)
      : null;

    const needsApproval = await adjustmentNeedsApproval(
      this.db,
      orgId,
      await this.settings.get(orgId),
      data.lines,
      variants,
    );

    const adjustmentId = await this.db.transaction(async (tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        data,
        async () => {
          const refNum = await this.numSeq.next(orgId, "ADJUSTMENT", tx);
          const [adj] = await tx.insert(invStockAdjustments).values({
            orgId,
            referenceNumber: refNum,
            reason: data.reason,
            notes: data.notes,
            scrapLocationId,
            status: needsApproval ? "PENDING_APPROVAL" : "PENDING_POST",
            createdBy: userId,
          }).returning({ id: invStockAdjustments.id, refNum: invStockAdjustments.referenceNumber });
          if (!adj) throw new ConflictException("Could not open the adjustment");

          await tx.insert(invStockAdjustmentLines).values(
            data.lines.map((line) => ({
              orgId,
              adjustmentId: adj.id,
              productVariantId: line.productVariantId,
              locationId: line.locationId,
              quantityChange: line.quantityChange.toString(),
              notes: line.notes,
            }))
          );

          if (!needsApproval) {
            const stored = await tx.query.invStockAdjustments.findFirst({
              where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adj.id)),
              with: { lines: true },
            });
            if (stored) {
              await this.applyAdjustmentLinesInTx(tx, orgId, userId, stored, `${idempotencyKey}:post`);
            }
          } else {
            // G3. An adjustment that stops at PENDING_APPROVAL is waiting on a
            // person, and until now nothing told that person. Emitted inside the
            // same transaction that created it, so the adjustment and the signal
            // commit together — and so the adjustment still commits when nothing
            // is listening, because the outbox row simply waits for the relay.
            await OutboxWriter.emit(tx, {
              eventId: randomUUID(),
              organizationId: orgId,
              aggregateType: "inv_stock_adjustment",
              aggregateId: String(adj.id),
              aggregateVersion: 1,
              eventType: "inventory.adjustment.approval_requested",
              payload: {
                adjustmentId: adj.id,
                referenceNumber: adj.refNum,
                reason: data.reason,
                lineCount: data.lines.length,
                requestedByUserId: userId,
              },
              occurredAt: new Date(),
            });
          }

          return adj.id;
        },
        // The stored id has been through jsonb and may come back as a string,
        // so it is parsed rather than cast; a garbled row fails loudly here
        // instead of becoming a NaN lookup that finds nothing.
        (stored) => {
          const id = revivedId(stored);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return id;
        },
      ),
    );

    if (!needsApproval) await this.engine.invalidateCaches(orgId);

    return this.getAdjustment(orgId, adjustmentId, userId);
  }

  /**
   * A3. Approving is safe to repeat — the UPDATE is conditional on
   * PENDING_APPROVAL and the affected-row count is checked — but a retry after a
   * timeout got a 409 saying the adjustment was no longer pending, when the
   * caller's own earlier request is what approved it. That is the same shape as
   * a repeated confirm or dispatch, and the key exists to replay the answer
   * rather than to make the write safe.
   */
  async approveAdjustment(
    orgId: string,
    userId: string,
    adjustmentId: number,
    idempotencyKey: string,
  ) {
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    if (adj.status !== "PENDING_APPROVAL") throw new BadRequestException("Only PENDING_APPROVAL adjustments can be approved");

    // Writing off stock is how theft is concealed, so the person who raised the
    // adjustment may never be the person who approves it. Same maker-checker rule
    // payroll enforces on run approval.
    if (adj.createdBy === userId) {
      throw new ForbiddenException(
        "Maker-checker violation: the person who raised an adjustment cannot approve it",
      );
    }

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.adjustments.approve", adjustmentId },
        async () => {
          const updated = await tx.update(invStockAdjustments)
            .set({ status: "APPROVED", approvedBy: userId, approvedAt: new Date() })
            .where(and(
              eq(invStockAdjustments.orgId, orgId),
              eq(invStockAdjustments.id, adjustmentId),
              eq(invStockAdjustments.status, "PENDING_APPROVAL"),
            ))
            .returning({ id: invStockAdjustments.id });
          if (updated.length === 0)
            throw new ConflictException("Adjustment is no longer pending approval");
          return adjustmentId;
        },
        revivedId,
      ),
    );

    return this.getAdjustment(orgId, adjustmentId, userId);
  }

  async postAdjustment(orgId: string, userId: string, adjustmentId: number, idempotencyKey: string) {
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      with: { lines: true },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    // D8. "Unapproved cannot post" is this line, and PENDING_APPROVAL is the
    // status `createAdjustment` gives a document over either threshold — so a
    // write-off that needs a second signature has no route to the ledger until
    // `approveAdjustment` has been through maker-checker.
    if (adj.status !== "APPROVED" && adj.status !== "PENDING_POST") {
      throw new BadRequestException("Adjustment must be APPROVED or PENDING_POST to post");
    }

    await this.applyAdjustmentLines(orgId, userId, adj, idempotencyKey);
    return this.getAdjustment(orgId, adjustmentId, userId);
  }

  async cancelAdjustment(orgId: string, adjustmentId: number) {
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      columns: { id: true, status: true },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    if (adj.status === "POSTED") throw new BadRequestException("Posted adjustments cannot be cancelled");

    await this.db.update(invStockAdjustments)
      .set({ status: "CANCELLED" })
      .where(and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)));

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
    ]);
  }

  // B1-05/B1-11: engine.executeInTx + status transition to POSTED in one transaction.
  // A crash can no longer leave stock moved with the record still at PENDING_POST.
  // Both cache invalidations run in parallel after the tx commits (B1-11).
  private async applyAdjustmentLines(
    orgId: string,
    userId: string,
    adj: PostableAdjustment,
    idempotencyKey: string,
  ) {
    await this.db.transaction((tx: Tx) =>
      this.applyAdjustmentLinesInTx(tx, orgId, userId, adj, idempotencyKey),
    );

    await Promise.all([
      this.engine.invalidateCaches(orgId),
    ]);
  }

  /**
   * The posting itself, on a transaction the caller owns.
   *
   * `createAdjustment` needs the posting to share the transaction that claimed
   * its idempotency key, so that a claim can never commit over work that did
   * not. Opening a second transaction here would have separated the two.
   */
  private async applyAdjustmentLinesInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    adj: PostableAdjustment,
    idempotencyKey: string,
  ) {
    const result = await this.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey,
      sourceType: "inv_adjustment",
      sourceId: adj.id.toString(),
      reason: adj.reason,
      movements: adj.lines.map((line) => ({
        // `parseFloat` on an 18,4 numeric is banned here for the reason it is
        // banned everywhere: 0.0001 of drift decides the sign of a movement.
        transactionType: adjustmentMovementType(adj.reason, line.quantityChange),
        productVariantId: line.productVariantId,
        locationId: line.locationId,
        quantityDelta: line.quantityChange,
      })),
    });

    const writtenOffValue = await this.issuedValueOf(tx, orgId, result.transactionIds);

    await tx.update(invStockAdjustments)
      .set({ status: "POSTED", postedBy: userId, postedAt: new Date(), writtenOffValue })
      .where(and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adj.id)));

    await OutboxWriter.emit(tx, {
      eventId: randomUUID(),
      organizationId: orgId,
      aggregateType: "inv_stock_adjustment",
      aggregateId: String(adj.id),
      aggregateVersion: Date.now(),
      eventType: "inventory.stock.adjusted",
      payload: {
        adjustmentId: adj.id,
        referenceNumber: adj.referenceNumber,
        reason: adj.reason,
        writeOff: isWriteOffReason(adj.reason),
        scrapLocationId: adj.scrapLocationId,
        writtenOffValue,
        lineCount: adj.lines.length,
        actorUserId: userId,
      },
      occurredAt: new Date(),
    });
  }

  /**
   * D8 — what the document actually cost, read back off the ledger it just
   * wrote.
   *
   * `total_cost` on an issue row is whatever `planIssue` found the cost layers
   * to be carrying, and every draw it made is recorded in
   * `inv_valuation_consumptions`, so this figure is reproducible from the rows
   * rather than being a second opinion about them. Estimating it instead —
   * quantity times the variant's cost price — would have been wrong by the
   * whole spread between the layers under FIFO, and wrong by every price change
   * since the last receipt under weighted average.
   *
   * Negative movements only: on a mixed adjustment the value written off is
   * what left, not what left netted against what arrived.
   */
  private async issuedValueOf(tx: Tx, orgId: string, transactionIds: readonly number[]): Promise<string | null> {
    if (transactionIds.length === 0) return null;
    const [row] = await tx.execute<{ value: string }>(sql`
      SELECT COALESCE(SUM(total_cost), 0)::text AS value
      FROM inv_stock_transactions
      WHERE org_id = ${orgId}
        AND quantity_change < 0
        AND id IN (${sql.join(transactionIds.map((id) => sql`${id}`), sql`, `)})
    `);
    return row?.value ?? null;
  }
}
