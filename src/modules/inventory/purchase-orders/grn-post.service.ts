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
  invGrnLines,
  invQualityInspections,
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
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import { addDec, cmpDec, divDec, mulDec, subDec, isPositive } from "../stock-engine/decimal";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { emitReceiptPosted } from "./lib/receipt-events";
import { postReceiptJournal } from "./lib/receipt-journal";
import {
  assertLotAcceptable,
  assertSerialsAcceptable,
  resolveLotId,
  resolveSerialIds,
} from "./lib/receipt-lots-serials";
import type { ReverseGrnInput } from "./dto/inv-purchase-orders.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type DiscrepancyReason = "SHORT" | "OVER" | "DAMAGED" | "WRONG_ITEM";

/** What a posting movement needs, assembled per line before the engine is called. */
interface PendingMovement {
  transactionType: string;
  productVariantId: number;
  locationId: number;
  lotId: number | undefined;
  serialId: number | undefined;
  quantityDelta: string;
  unitCost: string | undefined;
}

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
    private readonly numSeq: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly journalPosting: InventoryAccountingBridge,
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
   * The post itself, on a transaction the caller owns. `receiveGoods` needs the
   * draft creation and the post to share one claim, so this cannot open its own.
   */
  async postInTx(
    tx: Tx,
    orgId: string,
    grnId: number,
    userId: string,
    idempotencyKey: string,
  ): Promise<number> {
    // The row lock, before anything is read. Two posts of the same receipt
    // otherwise both see a postable status and both move stock; the status
    // check afterwards is only meaningful because the lock is held.
    const [locked] = await tx.execute<{ status: string }>(sql`
      SELECT status FROM inv_grns WHERE id = ${grnId} AND org_id = ${orgId} FOR UPDATE`);
    if (!locked) throw new NotFoundException("Goods receipt not found");
    if (locked.status === "POSTED")
      throw new ConflictException("This goods receipt has already been posted");
    if (locked.status === "CANCELLED")
      throw new BadRequestException("A cancelled goods receipt cannot be posted");

    const grn = await tx.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      with: { lines: { with: { serials: { columns: { serialNumber: true } } } } },
    });
    if (!grn) throw new NotFoundException("Goods receipt not found");
    if (grn.lines.length === 0)
      throw new BadRequestException("A goods receipt with no lines cannot be posted");
    const locationId = grn.locationId;
    if (locationId === null)
      throw new BadRequestException("This goods receipt has no receiving location");

    const po = await tx.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, grn.poId), eq(invPurchaseOrders.orgId, orgId)),
      with: {
        lines: {
          with: {
            productVariant: {
              with: { product: { columns: { id: true, trackingMethod: true } } },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "SENT" && po.status !== "PARTIAL") {
      throw new BadRequestException(
        "Purchase order must be SENT or PARTIAL to receive goods",
      );
    }

    const settings = await this.settingsService.get(orgId);

    // What each line owed at the moment it posts, computed under the row lock in
    // the validation pass and carried to the write pass so both agree.
    const expectedByLine = new Map<
      number,
      { expected: string; discrepancyReason: DiscrepancyReason | null }
    >();

    for (const line of grn.lines) {
      const poLine = po.lines.find((l) => l.id === line.poLineId);
      if (!poLine) throw new BadRequestException(`PO line ${line.poLineId} not found`);

      const [lockedLine] = await tx.execute<{
        quantity: string;
        quantity_received: string;
      }>(sql`
        SELECT quantity, quantity_received
        FROM inv_po_lines
        WHERE id = ${line.poLineId}
          AND po_id = ${po.id}
        FOR UPDATE
      `);
      if (!lockedLine)
        throw new BadRequestException(`PO line ${line.poLineId} not found`);

      // Exact throughout: the old form parsed both sides to floats and added an
      // 0.0001 epsilon to paper over the comparison.
      const remaining = subDec(
        String(lockedLine.quantity),
        String(lockedLine.quantity_received),
      );
      const maxAllowed = addDec(
        remaining,
        mulDec(remaining, divDec(settings.overReceiptTolerancePct, "100")),
      );

      if (cmpDec(line.quantityReceived, maxAllowed) > 0) {
        throw new BadRequestException(
          `Line ${line.poLineId}: received qty ${line.quantityReceived} exceeds allowed max ${maxAllowed} (over-receipt tolerance ${settings.overReceiptTolerancePct}%)`,
        );
      }

      // What the line still owed at this moment, so a short delivery stays
      // legible after the purchase order moves on. An over-receipt is
      // exceptional by definition -- it passed the tolerance gate above -- so it
      // is labelled even when the receiver did not say why.
      const overReceipt = cmpDec(line.quantityReceived, remaining) > 0;
      expectedByLine.set(line.id, {
        expected: remaining,
        discrepancyReason:
          line.discrepancyReason ?? (overReceipt ? ("OVER" as const) : null),
      });

      await assertLotAcceptable(
        tx, orgId, line, poLine.productVariantId, grn.receivedDate, settings.expiryReservationPolicy,
      );

      if (poLine.productVariant.product.trackingMethod === "SERIAL")
        await assertSerialsAcceptable(tx, orgId, line, poLine.productVariantId);
    }

    const movements: PendingMovement[] = [];

    for (const line of grn.lines) {
      const poLine = po.lines.find((l) => l.id === line.poLineId)!;
      const trackingMethod = poLine.productVariant.product.trackingMethod;

      const expected = expectedByLine.get(line.id);
      await tx
        .update(invGrnLines)
        .set({
          quantityExpected: expected?.expected ?? null,
          discrepancyReason: expected?.discrepancyReason ?? null,
        })
        .where(and(eq(invGrnLines.id, line.id), eq(invGrnLines.orgId, orgId)));

      // A1. Goods that have arrived are no longer on order, or the bucket only
      // grows and replenishment sees a permanent phantom inbound. It belongs to
      // the post, not the draft: an uncounted delivery is still expected.
      if (po.warehouseId !== null) {
        await this.projection.addOnOrder(
          tx,
          orgId,
          poLine.productVariantId,
          po.warehouseId,
          `-${line.quantityReceived}`,
        );
      }

      await tx
        .update(invPoLines)
        .set({
          quantityReceived: sql`${invPoLines.quantityReceived} + ${line.quantityReceived}::numeric`,
        })
        .where(and(eq(invPoLines.id, line.poLineId), eq(invPoLines.poId, po.id)));

      /**
       * A refused line stops here, before the lot and the serials. Receiving
       * used to open an `inv_lots` row and mark every scanned unit IN_STOCK
       * before it looked at the quality status, so goods the warehouse had
       * refused became owned units with a location and a batch, blocking those
       * serials from ever being received again and backed by no ledger row. The
       * serials stay on the receipt line either way, which is where the evidence
       * of what was refused belongs.
       */
      if (line.qualityStatus !== "ACCEPTED") continue;

      const lotId =
        trackingMethod === "LOT" && line.lotNumber
          ? await resolveLotId(tx, orgId, poLine.productVariantId, line)
          : undefined;

      if (trackingMethod === "SERIAL") {
        const serialIds = await resolveSerialIds(
          tx,
          orgId,
          poLine.productVariantId,
          locationId,
          lotId,
          line.serials.map((s) => s.serialNumber),
        );
        for (const serialId of serialIds) {
          movements.push({
            transactionType: "GRN",
            productVariantId: poLine.productVariantId,
            locationId,
            lotId: undefined,
            serialId,
            quantityDelta: "1.0000",
            unitCost: poLine.unitCost ?? undefined,
          });
        }
      } else {
        movements.push({
          transactionType: "GRN",
          productVariantId: poLine.productVariantId,
          locationId,
          lotId,
          serialId: undefined,
          quantityDelta: line.quantityReceived,
          unitCost: poLine.unitCost ?? undefined,
        });
      }
    }

    const allLines = await tx.query.invPoLines.findMany({
      where: eq(invPoLines.poId, po.id),
    });
    const allReceived = allLines.every(
      (l) => cmpDec(l.quantityReceived, l.quantity) >= 0,
    );
    await tx
      .update(invPurchaseOrders)
      .set({ status: allReceived ? "RECEIVED" : "PARTIAL", updatedAt: new Date() })
      .where(
        and(eq(invPurchaseOrders.id, po.id), eq(invPurchaseOrders.orgId, orgId)),
      );

    if (movements.length > 0) {
      // A derived key: the same key claimed twice in one transaction is a
      // duplicate, not a nesting. Valuation layers are written inside this call.
      await this.engine.executeInTx(tx, orgId, userId, {
        idempotencyKey: `${idempotencyKey}:stock`,
        sourceType: "inv_grn",
        sourceId: String(grn.id),
        reason: `GRN: ${grn.grnNumber}`,
        movements,
      });
    }

    await tx
      .update(invGrns)
      .set({ status: "POSTED", postedBy: userId, postedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invGrns.id, grn.id), eq(invGrns.orgId, orgId)));

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "receiving.post",
      resourceType: "inv_grn",
      resourceId: String(grn.id),
      before: { status: locked.status },
      after: { status: "POSTED" },
      metadata: {
        poId: po.id,
        grnNumber: grn.grnNumber,
        lineCount: grn.lines.length,
        movementCount: movements.length,
      },
    });

    await emitReceiptPosted(tx, {
      orgId,
      actorUserId: userId,
      idempotencyKey,
      grnId: grn.id,
      grnNumber: grn.grnNumber,
      receivedDate: grn.receivedDate,
      locationId,
      poId: po.id,
      poNumber: po.poNumber,
      vendorId: po.vendorId,
      warehouseId: po.warehouseId,
      lineCount: grn.lines.length,
      acceptedLineCount: grn.lines.filter((l) => l.qualityStatus === "ACCEPTED").length,
      purchaseOrderStatus: allReceived ? "RECEIVED" : "PARTIAL",
    });

    await postReceiptJournal(this.journalPosting, orgId, userId, grn, po, grn.lines);

    if (settings.inspectionOnReceipt) {
      const inspNumber = await this.numSeq.next(orgId, "INSPECTION", tx);
      await tx.insert(invQualityInspections).values({
        orgId,
        inspectionNumber: inspNumber,
        sourceType: "inv_grn",
        sourceId: String(grn.id),
        status: "PENDING",
        createdBy: userId,
      });
    }

    return grn.id;
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
