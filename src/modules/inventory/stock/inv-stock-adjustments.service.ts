import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  invStockAdjustments, invStockAdjustmentLines, invProductVariants, invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { StockMovementBridgeService } from "../../accounting/adapters/stock-movement-bridge.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { ListAdjustmentsInput, CreateAdjustmentInput } from "./dto/inv-stock.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class InvStockAdjustmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly settings: InventorySettingsService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly glBridge: StockMovementBridgeService,
  ) {}

  async listAdjustments(orgId: string, filters: ListAdjustmentsInput, scope: DataScope = "all", userId?: string) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invStockAdjustments.orgId, orgId)];
    if (status) conditions.push(eq(invStockAdjustments.status, status));
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

    return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
  }

  async getAdjustment(orgId: string, adjustmentId: number) {
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      with: {
        creator: { columns: { id: true, name: true } },
        approver: { columns: { id: true, name: true } },
        poster: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            location: { columns: { id: true, name: true, code: true } },
          },
        },
      },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    return adj;
  }

  /**
   * Every variant and location a line names, checked against this organisation.
   *
   * The lines used to go straight in and let the foreign keys decide. A client
   * naming a variant that does not exist got a raw 23503 through
   * `AllExceptionsFilter` — a 500 for what is plainly a bad request, with the
   * failed statement in the log and nothing useful in the response.
   *
   * Scoped to `orgId` as well as to existence, which the foreign keys cannot do:
   * they are on the id alone, so another tenant's variant id would have
   * satisfied them. That is the check that has to happen here or nowhere.
   */
  private async assertLinesResolve(
    orgId: string,
    lines: CreateAdjustmentInput["lines"],
  ): Promise<void> {
    const variantIds = [...new Set(lines.map((line) => line.productVariantId))];
    const locationIds = [...new Set(lines.map((line) => line.locationId))];

    const [variants, locations] = await Promise.all([
      this.db
        .select({ id: invProductVariants.id })
        .from(invProductVariants)
        .where(and(eq(invProductVariants.orgId, orgId), inArray(invProductVariants.id, variantIds))),
      this.db
        .select({ id: invLocations.id })
        .from(invLocations)
        .where(and(eq(invLocations.orgId, orgId), inArray(invLocations.id, locationIds))),
    ]);

    const missingVariant = variantIds.find(
      (id) => !variants.some((row) => row.id === id),
    );
    if (missingVariant !== undefined)
      throw new NotFoundException(`No product variant ${String(missingVariant)} in this organisation`);

    const missingLocation = locationIds.find(
      (id) => !locations.some((row) => row.id === id),
    );
    if (missingLocation !== undefined)
      throw new NotFoundException(`No location ${String(missingLocation)} in this organisation`);
  }

  async createAdjustment(orgId: string, userId: string, data: CreateAdjustmentInput, idempotencyKey: string) {
    await this.assertLinesResolve(orgId, data.lines);

    const cfg = await this.settings.get(orgId);
    const totalAbsQty = data.lines.reduce((sum, l) => sum + Math.abs(l.quantityChange), 0);
    const threshold = cfg.adjustmentApprovalThreshold !== null ? parseFloat(cfg.adjustmentApprovalThreshold) : null;
    const needsApproval = threshold !== null && totalAbsQty > threshold;

    const referenceNumber = await this.db.transaction(async (tx) => {
      const refNum = await this.numSeq.next(orgId, "ADJUSTMENT", tx);
      const [adj] = await tx.insert(invStockAdjustments).values({
        orgId,
        referenceNumber: refNum,
        reason: data.reason,
        notes: data.notes,
        status: needsApproval ? "PENDING_APPROVAL" : "PENDING_POST",
        createdBy: userId,
      }).returning({ id: invStockAdjustments.id, refNum: invStockAdjustments.referenceNumber });

      await tx.insert(invStockAdjustmentLines).values(
        data.lines.map((line) => ({
          adjustmentId: adj!.id,
          productVariantId: line.productVariantId,
          locationId: line.locationId,
          quantityChange: line.quantityChange.toString(),
          notes: line.notes,
        }))
      );

      return refNum;
    });

    if (!needsApproval) {
      const adj = await this.db.query.invStockAdjustments.findFirst({
        where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.referenceNumber, referenceNumber)),
        with: { lines: true },
      });
      if (adj) {
        await this.applyAdjustmentLines(orgId, userId, adj, idempotencyKey);
      }
    }

    const result = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.referenceNumber, referenceNumber)),
      with: { lines: true, creator: { columns: { id: true, name: true } } },
    });
    return result;
  }

  async approveAdjustment(orgId: string, userId: string, adjustmentId: number) {
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

    const updated = await this.db.update(invStockAdjustments)
      .set({ status: "APPROVED", approvedBy: userId, approvedAt: new Date() })
      .where(and(
        eq(invStockAdjustments.orgId, orgId),
        eq(invStockAdjustments.id, adjustmentId),
        eq(invStockAdjustments.status, "PENDING_APPROVAL"),
      ))
      .returning({ id: invStockAdjustments.id });
    if (updated.length === 0) throw new ConflictException("Adjustment is no longer pending approval");

    return this.getAdjustment(orgId, adjustmentId);
  }

  async postAdjustment(orgId: string, userId: string, adjustmentId: number, idempotencyKey: string) {
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      with: { lines: true },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    if (adj.status !== "APPROVED" && adj.status !== "PENDING_POST") {
      throw new BadRequestException("Adjustment must be APPROVED or PENDING_POST to post");
    }

    await this.applyAdjustmentLines(orgId, userId, adj, idempotencyKey);
    return this.getAdjustment(orgId, adjustmentId);
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
    adj: { id: number; referenceNumber: string; reason: string; notes: string | null; lines: Array<{ productVariantId: number; locationId: number; quantityChange: string }> },
    idempotencyKey: string,
  ) {
    await this.db.transaction(async (tx: Tx) => {
      const moved = await this.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey,
        sourceType: "inv_adjustment",
        sourceId: adj.id.toString(),
        reason: adj.reason,
        movements: adj.lines.map((line) => ({
          transactionType: parseFloat(line.quantityChange) > 0 ? "ADJUSTMENT_IN" as const : "ADJUSTMENT_OUT" as const,
          productVariantId: line.productVariantId,
          locationId: line.locationId,
          quantityDelta: line.quantityChange,
        })),
      });

      // ACC-21. An adjustment changes what the business owns, so it belongs in
      // the ledger — on this transaction, so a refusal takes the stock change
      // with it rather than leaving the two disagreeing. The bridge reads the
      // value from the rows just written; nothing here says what it is worth.
      await this.glBridge.post(
        orgId,
        userId,
        {
          kind: "adjustment",
          documentId: String(adj.id),
          transactionIds: moved.transactionIds,
          journalDate: new Date().toISOString().slice(0, 10),
          memo: `Stock adjustment ${adj.referenceNumber}`,
        },
        tx,
      );

      await tx.update(invStockAdjustments)
        .set({ status: "POSTED", postedBy: userId, postedAt: new Date() })
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
          lineCount: adj.lines.length,
          actorUserId: userId,
        },
        occurredAt: new Date(),
      });
    });

    await Promise.all([
      this.engine.invalidateCaches(orgId),
    ]);
  }
}
