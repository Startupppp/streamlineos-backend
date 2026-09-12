import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  invPurchaseOrders,
  invPoLines,
  invGrns,
  invStockTransactions,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import { ReservationService } from "../stock-engine/reservation.service";
import { postInTx, type GrnPostDeps } from "./lib/grn-post-tx";
import { isPositive } from "../stock-engine/decimal";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import type { ReverseGrnInput } from "./dto/inv-purchase-orders.schemas";
import { ReceiptInspectionService } from "../quality/receipt-inspection.service";
import { InvPharmacyService } from "../products/inv-pharmacy.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];


/**
 * B1 — turning a counted delivery into stock.
 *
 * Everything here writes to the ledger, which is why it is separate from the
 * document lifecycle in `grn.service.ts`: opening, counting and cancelling a
 * receipt touch no stock at all, so "did this move anything" is answerable by
 * reading one import. The post is a single transaction and the list of what sits
 * inside it is not negotiable — the outstanding purchase-order quantity under a
 * row lock, the UOM factor already snapshotted on the line, the lot and serial
 * rows, the engine movements (which carry the valuation layers), the order's own
 * status, the audit record, the outbox events and the journal entry. Any of
 * those outside it is a way for stock to exist without its paperwork, or the
 * reverse.
 */
@Injectable()
export class GrnPostingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly projection: StockProjectionService,
    private readonly settingsService: InventorySettingsService,
    private readonly audit: InventoryAuditService,
    private readonly receiptInspection: ReceiptInspectionService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly journalPosting: InventoryAccountingBridge,
    private readonly pharmacy: InvPharmacyService,
    private readonly reservations: ReservationService,
  ) {}

  /**
   * Posts a receipt that is already open, under its own idempotency claim.
   *
   * The claim spans the whole command rather than the engine call alone: a
   * delivery whose every line was REJECTED produces no movements, so a claim
   * around the engine alone leaves that case unprotected — the defect A3 found
   * on the combined receive path.
   */
  async postGrn(
    orgId: string,
    grnId: number,
    userId: string,
    idempotencyKey: string,
  ): Promise<number> {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      columns: { id: true, status: true, locationId: true, poId: true },
    });
    if (!grn) throw new NotFoundException("Goods receipt not found");
    await this.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);

    const posted = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.receiving.post", grnId },
        () => this.postInTx(tx, orgId, grnId, userId, idempotencyKey),
        (stored) => {
          const id = revivedId(stored);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return id;
        },
      ),
    );

    await this.invalidateAfterPost(orgId, grn.poId);
    return posted;
  }

  /**
   * @see lib/grn-post-tx.ts — the body moved out, the surface did not.
   *
   * Deliberately NOT decomposed further: it is one function that takes the
   * purchase-order row lock, moves stock, posts the journal and raises
   * inspections, and the comments through it explain why each step sits where
   * it does relative to that lock. Splitting it into phases is a real refactor
   * of receipt posting and belongs in its own ticket, not in a file-size one.
   */
  async postInTx(
    tx: Tx,
    orgId: string,
    grnId: number,
    userId: string,
    idempotencyKey: string,
  ): Promise<number> {
    return postInTx(this.grnPostDeps, tx, orgId, grnId, userId, idempotencyKey);
  }

  /**
   * Built explicitly rather than passing `this`: TypeScript will not
   * structurally match a class carrying `private` members to an interface.
   */
  private get grnPostDeps(): GrnPostDeps {
    return {
      engine: this.engine,
      projection: this.projection,
      settingsService: this.settingsService,
      audit: this.audit,
      receiptInspection: this.receiptInspection,
      journalPosting: this.journalPosting,
      pharmacy: this.pharmacy,
      reservations: this.reservations,
    };
  }

  /**
   * Unwinds a posted receipt with compensating movements. Restricted to POSTED
   * because there is nothing else to unwind: an unposted receipt moved no stock
   * and is abandoned with `cancel`. Before B1 that distinction did not exist and
   * the only guard was "did this document leave any ledger rows", which answers
   * a different question.
   */
  async reverseGrn(
    orgId: string,
    grnId: number,
    userId: string,
    idempotencyKey: string,
    data: ReverseGrnInput,
  ) {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      with: { lines: true },
    });
    if (!grn) throw new NotFoundException("GRN not found");
    await this.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);
    if (grn.status !== "POSTED")
      throw new BadRequestException("Only a POSTED goods receipt can be reversed");

    const txns = await this.db.query.invStockTransactions.findMany({
      where: and(
        eq(invStockTransactions.orgId, orgId),
        eq(invStockTransactions.referenceType, "inv_grn"),
        eq(invStockTransactions.referenceId, String(grnId)),
      ),
    });

    if (txns.length === 0)
      throw new BadRequestException("No stock transactions found for this GRN");

    // D3. An open inspection is holding these goods in QUALITY_HOLD, which is a
    // subset of `on_hand` at the grain. Reversing the receipt drives `on_hand`
    // below the standing hold and the engine refuses with a bare
    // HOLD_EXCEEDS_ON_HAND — correct, but it tells the operator nothing about
    // what to do. Say it here, where the reason is known.
    const holding = await this.receiptInspection.openInspectionFor(orgId, grnId);
    if (holding !== null) {
      throw new BadRequestException(
        `Inspection ${holding} is holding this receipt's goods. Complete or cancel it before reversing the receipt.`,
      );
    }

    await this.db.transaction(async (tx) => {
      for (const txn of txns) {
        await this.engine.reverseInTx(tx, orgId, userId, {
          idempotencyKey: `${idempotencyKey}:rev:${txn.id}`,
          stockTransactionId: txn.id,
          reason: data.reason,
        });
      }

      const po = await tx.query.invPurchaseOrders.findFirst({
        where: and(
          eq(invPurchaseOrders.id, grn.poId),
          eq(invPurchaseOrders.orgId, orgId),
        ),
        with: { lines: true },
      });

      if (po) {
        for (const grnLine of grn.lines) {
          await tx
            .update(invPoLines)
            .set({
              quantityReceived: sql`GREATEST(0, ${invPoLines.quantityReceived} - ${grnLine.quantityReceived})`,
            })
            .where(and(eq(invPoLines.id, grnLine.poLineId), eq(invPoLines.poId, po.id)));
        }

        const updatedLines = await tx.query.invPoLines.findMany({
          where: eq(invPoLines.poId, po.id),
        });
        const anyReceived = updatedLines.some((l) => isPositive(l.quantityReceived));

        await tx
          .update(invPurchaseOrders)
          .set({ status: anyReceived ? "PARTIAL" : "SENT", updatedAt: new Date() })
          .where(
            and(eq(invPurchaseOrders.id, po.id), eq(invPurchaseOrders.orgId, orgId)),
          );
      }

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "receiving.reverse",
        resourceType: "inv_grn",
        resourceId: String(grnId),
        metadata: { reason: data.reason, transactionCount: txns.length },
      });
    });

    await this.invalidateAfterPost(orgId, grn.poId);

    return { reversed: true, grnId, transactionCount: txns.length };
  }

  /** Public: the combined receive path owns its commit, so it owns this too. */
  async invalidateAfterPost(orgId: string, poId: number): Promise<void> {
    await this.engine.invalidateCaches(orgId);
    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId)),
    ]);
  }


}
