import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { invStockAdjustments } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { StockEngineService } from "../../stock-engine/stock-engine.service";
import { StockMovementBridgeService } from "../../../accounting/adapters/stock-movement-bridge.service";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import { adjustmentMovementType, isWriteOffReason } from "./write-off";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The document as the posting path needs it. Moved here with its only writer. */
export interface PostableAdjustment {
  id: number;
  referenceNumber: string;
  reason: string;
  notes: string | null;
  scrapLocationId: number | null;
  lines: Array<{ productVariantId: number; locationId: number; quantityChange: string }>;
}


/**
 * Posting adjustment lines to the ledger, and reading back what they cost,
 * lifted out of `inv-stock-adjustments.service.ts` unchanged.
 *
 * Neither has ever had a caller outside that service. `applyAdjustmentLinesInTx`
 * uses the stock engine and the general-ledger bridge, which arrive as its first
 * two arguments; `issuedValueOf` used nothing at all.
 */
  /**
   * The posting itself, on a transaction the caller owns.
   *
   * `createAdjustment` needs the posting to share the transaction that claimed
   * its idempotency key, so that a claim can never commit over work that did
   * not. Opening a second transaction here would have separated the two.
   */
export async function applyAdjustmentLinesInTx(
    engine: StockEngineService,
    glBridge: StockMovementBridgeService,
    tx: Tx,
    orgId: string,
    userId: string,
    adj: PostableAdjustment,
    idempotencyKey: string,
  ) {
    const result = await engine.executeInTx(tx, orgId, userId, {
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

    // ACC-21. An adjustment changes what the business owns, so it belongs in
    // the ledger — on this transaction, so a refusal takes the stock change
    // with it rather than leaving the two disagreeing. The bridge reads the
    // value from the rows just written; nothing here says what it is worth.
    // A write-off's lines move as SCRAP (`adjustmentMovementType`), which the
    // bridge books to inventory_write_off rather than inventory_adjustment.
    await glBridge.post(
      orgId,
      userId,
      {
        kind: "adjustment",
        documentId: String(adj.id),
        transactionIds: result.transactionIds,
        journalDate: new Date().toISOString().slice(0, 10),
        memo: `Stock adjustment ${adj.referenceNumber}`,
      },
      tx,
    );

    const writtenOffValue = await issuedValueOf(tx, orgId, result.transactionIds);

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
export async function issuedValueOf(tx: Tx, orgId: string, transactionIds: readonly number[]): Promise<string | null> {
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
