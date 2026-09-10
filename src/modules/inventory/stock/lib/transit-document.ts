import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invStockTransfers } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { isPositive, subDec } from "../../stock-engine/decimal";
import { INV_ERRORS } from "../../stock-engine/stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Reading the transit document, and deciding what its status becomes, lifted out
 * of `transit-exit.service.ts` unchanged.
 *
 * Both already took their executor as an argument and reached for nothing on the
 * service. Neither has a caller outside it — `inv-stock-transfers.service.ts`
 * has its OWN private `loadTransfer`, which is a different method against a
 * different gate, so the name collision is not a shared dependency.
 */
  /**
   * The transfer, its lines, and the warehouse the goods left.
   *
   * `from_warehouse_id` is nullable on the header — a transfer may name only its
   * locations — so the source location's own warehouse is the fallback, and the
   * only answer that is always available.
   */
export async function loadTransfer(tx: Tx, orgId: string, transferId: number) {
    const [header] = await tx.execute<{
      id: number;
      status: string;
      reference_number: string | null;
      from_location_id: number;
      dispatched_at: Date | null;
      source_warehouse_id: number | null;
    }>(sql`
      SELECT t.id,
             t.status::text AS status,
             t.reference_number,
             t.from_location_id,
             t.dispatched_at,
             COALESCE(t.from_warehouse_id, src.warehouse_id) AS source_warehouse_id
        FROM inv_stock_transfers t
        JOIN inv_locations src ON src.org_id = t.org_id AND src.id = t.from_location_id
       WHERE t.org_id = ${orgId} AND t.id = ${transferId}
    `);
    if (!header) throw new NotFoundException("Transfer not found");

    // Nothing was ever parked in transit, so nothing can leave it. Refusing here
    // rather than letting the engine fail for want of stock keeps the error
    // about the document instead of about a bin the caller never named.
    if (header.dispatched_at === null) {
      throw new BadRequestException({
        code: INV_ERRORS.INVALID_DOCUMENT_STATE,
        message: "This transfer was never dispatched, so none of its goods are in transit",
      });
    }
    if (header.source_warehouse_id === null) {
      throw new BadRequestException({
        code: INV_ERRORS.WAREHOUSE_NOT_FOUND,
        message: "This transfer's source location no longer belongs to a warehouse",
      });
    }

    const lines = await tx.execute<{
      id: number;
      product_variant_id: number;
      lot_id: number | null;
      serial_id: number | null;
      quantity: string;
      quantity_received: string | null;
    }>(sql`
      SELECT id, product_variant_id, lot_id, serial_id,
             quantity::text AS quantity,
             quantity_received::text AS quantity_received
        FROM inv_stock_transfer_lines
       WHERE org_id = ${orgId} AND transfer_id = ${transferId}
       ORDER BY id
    `);

    // What earlier exits already took, read off the ledger.
    //
    // Without this the bound was `quantity - quantity_received`, which no exit
    // ever changes — so a second command under a *fresh* idempotency key
    // recomputed the identical remainder and posted it again. `runIdempotent`
    // cannot help: it fences a retry of the same request, not a second request.
    // The transit bin is shared by every dispatch out of that warehouse, so the
    // repeat would not even fail for want of stock; it would quietly take
    // another transfer's goods. The ledger is the only durable record of what
    // has left, and it is append-only, so it is the right thing to subtract.
    const exited = await tx.execute<{
      product_variant_id: number;
      lot_id: number | null;
      serial_id: number | null;
      quantity: string;
    }>(sql`
      SELECT product_variant_id, lot_id, serial_id,
             (-SUM(quantity_change::numeric))::text AS quantity
        FROM inv_stock_transactions
       WHERE org_id = ${orgId}
         AND reference_type = 'inv_transit_exit'
         AND reference_id = ${String(transferId)}
         AND quantity_change < 0
       GROUP BY product_variant_id, lot_id, serial_id
    `);

    return {
      status: header.status,
      referenceNumber: header.reference_number,
      fromLocationId: Number(header.from_location_id),
      sourceWarehouseId: Number(header.source_warehouse_id),
      lines: lines.map((row) => ({
        transferLineId: Number(row.id),
        productVariantId: Number(row.product_variant_id),
        lotId: row.lot_id === null ? null : Number(row.lot_id),
        serialId: row.serial_id === null ? null : Number(row.serial_id),
        stranded: subDec(String(row.quantity), String(row.quantity_received ?? "0")),
      })),
      alreadyExited: exited.map((row) => ({
        productVariantId: Number(row.product_variant_id),
        lotId: row.lot_id === null ? null : Number(row.lot_id),
        serialId: row.serial_id === null ? null : Number(row.serial_id),
        quantity: String(row.quantity),
      })),
    };
  }

  /**
   * The state machine decision `cancelTransfer` deferred.
   *
   * An IN_TRANSIT transfer had no terminal state but COMPLETED, so a journey
   * that was abandoned stayed IN_TRANSIT for ever and kept appearing in every
   * "goods on a van" report. Once nothing of it is left in transit it is over,
   * and which terminal state it reaches depends on whether anything arrived:
   * a transfer that delivered part of its load then wrote off the rest is
   * COMPLETED, one where nothing arrived at all is CANCELLED. A partial exit
   * changes nothing — units are still out there.
   */
export async function settleTransfer(
    tx: Tx,
    orgId: string,
    transferId: number,
    status: string,
    remaining: string,
  ): Promise<string> {
    if (status !== "IN_TRANSIT") return status;
    if (isPositive(remaining)) return status;

    const [received] = await tx.execute<{ any_received: boolean }>(sql`
      SELECT COALESCE(SUM(quantity_received::numeric), 0) > 0 AS any_received
        FROM inv_stock_transfer_lines
       WHERE org_id = ${orgId} AND transfer_id = ${transferId}
    `);
    const nextStatus = received?.any_received === true ? "COMPLETED" : "CANCELLED";

    await tx
      .update(invStockTransfers)
      .set(
        nextStatus === "COMPLETED"
          ? { status: "COMPLETED", completedAt: new Date() }
          : { status: "CANCELLED" },
      )
      .where(and(eq(invStockTransfers.orgId, orgId), eq(invStockTransfers.id, transferId)));

    return nextStatus;
  }
