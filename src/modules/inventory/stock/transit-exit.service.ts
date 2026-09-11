import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { TransitLocationService } from "../stock-engine/transit-location.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { INV_ERRORS, type StockMovement } from "../stock-engine/stock-engine.types";
import { queryStrandedTransit, type StrandedTransitRow } from "./lib/stranded-transit";
import { loadTransfer, settleTransfer } from "./lib/transit-document";
import {
  buildGrainBudgets,
  remainingStranded,
  resolveExitLines,
  reviveTransitExit,
  totalTaken,
  type TransitExitResult,
} from "./lib/transit-exit-lines";
import type {
  ListStrandedTransitInput,
  TransitExitInput,
} from "./dto/transit-exit.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Re-exported so the service's public surface is what it always was: the result
 * type is declared beside the `revive` that rebuilds it from stored JSON, and
 * moving the declaration rather than importing it back the other way is what
 * keeps `lib/` free of an edge into the service (`check:cycles` counts a
 * type-only import).
 */
export type { TransitExitResult } from "./lib/transit-exit-lines";


/**
 * R3, item 2 — the exit from transit, which until now did not exist.
 *
 * `dispatchTransfer` posts TRANSFER_OUT at the source bin and TRANSFER_IN at the
 * source warehouse's `TRANSIT` location, so goods on a van are on hand,
 * unsellable and countable. `completeTransfer` takes off it only what was
 * actually received. Everything else stays: a short receipt strands the
 * difference, an abandoned journey strands the lot, and `cancelTransfer` refuses
 * anything past RESERVED — by design, since there was nothing safe to do with
 * dispatched goods. The result was stock with no route out of a waypoint, and
 * `InvStockTransfersService.cancelTransfer` says so in as many words.
 *
 * This is that route, and the shape of it is forced by two standing rules.
 *
 * **It posts movements, it does not correct rows.** The ledger is append-only,
 * so units leave transit the way they entered it: through
 * `StockEngineService.executeInTx`, at the grain they are standing on, with a
 * reason on the row. Zeroing `inv_stock_levels` — or "cleaning up" the transit
 * bin with an UPDATE — would make the units vanish from the org's total for a
 * second time, which is the original A2 defect wearing a different hat.
 *
 * **It is one command with two dispositions, not two commands.** Returning goods
 * to the source and writing them off answer the same question and compete for
 * the same units; splitting them into separate endpoints would let both run
 * against one stranded quantity. One command, one idempotency claim, one
 * bounded remainder.
 *
 * **The remainder is bounded against the ledger, not against the document.**
 * `quantity - quantity_received` never changes when units exit, so bounding on
 * it alone lets a second command under a fresh idempotency key post the whole
 * shortfall again — `runIdempotent` fences a retry of the same request, not a
 * second request. `buildGrainBudgets` subtracts what earlier exits already took,
 * at the grain the stock level is keyed on. See `loadTransfer`.
 *
 * `WRITE_OFF` posts `SCRAP` rather than `ADJUSTMENT_OUT`, matching
 * `stock/lib/write-off.ts`: both are issues and both consume cost layers
 * identically, and the difference is whether a stock report can separate
 * shrinkage from a recount. It is deliberately not routed through
 * `InvStockAdjustmentsService`. An adjustment is a correction to what a *shelf*
 * holds and carries an approval ladder for that reason; this is a transfer
 * document reaching a terminal state, gated by its own key
 * (`inventory:transit:abandon`), and putting an approval queue between a
 * warehouse and the only exit from a stuck state is how the stuck state becomes
 * permanent again.
 *
 * No new event type. `MovementApplyService` already emits
 * `inventory.stock.movement.posted` for the command, carrying the movements, the
 * grains and the resulting positions; a name added to
 * `INVENTORY_COMMAND_EVENTS` without a matching route in
 * `INVENTORY_WEBHOOK_ROUTES` dead-letters in a background worker, and the fact a
 * consumer needs here — these units left transit — is fully carried by the
 * movement event plus the `inv_transit_exit` reference on every row it names.
 */
@Injectable()
export class TransitExitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly transitLocations: TransitLocationService,
  ) {}

  /**
   * R3, item 4 — what is standing in transit, and which document put it there.
   *
   * A command with no queue is a command nobody runs. This is the queue: one row
   * per transfer line that dispatched more than it received, carrying the
   * document, the grain, the transit bin and what is actually on hand there.
   *
   * Warehouse-scoped on the **transit** location's warehouse, which is the source
   * warehouse — that is where the goods are and whose stock they still count
   * against. Uncached: it is a small, scoped, permission-gated operational list
   * whose whole value is being current, and a cache here would need the resolved
   * scope in its key to avoid serving one operator's warehouses to the next.
   */
  async listStranded(
    orgId: string,
    userId: string,
    filters: ListStrandedTransitInput,
  ): Promise<{
    items: StrandedTransitRow[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty)
      return { items: [], total: 0, page: filters.page, totalPages: 0 };
    return queryStrandedTransit(this.db, orgId, filters, (column) =>
      scope.warehouse(column),
    );
  }

  /**
   * Move stranded units out of transit, one way or the other.
   *
   * Idempotent through `runIdempotent`, and it has to be: every movement here is
   * relative, so a retried abandon would take the quantity off transit twice —
   * and the second time either fails for want of stock or, where another
   * transfer's goods are standing on the same bin, silently takes theirs.
   */
  async exitTransit(
    orgId: string,
    userId: string,
    input: TransitExitInput,
    idempotencyKey: string,
  ): Promise<TransitExitResult> {
    const result = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.transit.exit", ...input },
        () => this.exitTransitInTx(tx, orgId, userId, input, idempotencyKey),
        (stored) => reviveTransitExit(stored),
      ),
    );

    await this.engine.invalidateCaches(orgId);
    return result;
  }

  private async exitTransitInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    input: TransitExitInput,
    idempotencyKey: string,
  ): Promise<TransitExitResult> {
    const transfer = await loadTransfer(tx, orgId, input.transferId);

    // BOLA, re-asserted on the specific document rather than on the key alone.
    // The engine re-checks every location it is handed; this refuses the
    // transfer itself, so a caller outside the source warehouse cannot even
    // learn what it stranded. NotFound rather than Forbidden — a 403 on another
    // warehouse's transfer id is an existence oracle.
    await this.warehouseScope.assertWarehouseVisible(
      orgId,
      userId,
      transfer.sourceWarehouseId,
    );

    const transitLocationId = await this.transitLocations.resolve(
      tx,
      orgId,
      transfer.sourceWarehouseId,
    );

    const budgets = buildGrainBudgets(transfer.lines, transfer.alreadyExited);
    const lines = resolveExitLines(transfer.lines, input.lines, budgets);
    if (lines.length === 0) {
      throw new BadRequestException({
        code: INV_ERRORS.INVALID_DOCUMENT_STATE,
        message:
          "Nothing on this transfer is standing in transit, so there is nothing to return or write off",
      });
    }

    const movements = lines.flatMap((line, lineIndex): StockMovement[] => {
      const issue: StockMovement = {
        transactionType:
          input.disposition === "RETURN_TO_SOURCE" ? "TRANSFER_OUT" : "SCRAP",
        productVariantId: line.productVariantId,
        locationId: transitLocationId,
        quantityDelta: `-${line.quantity}`,
        lotId: line.lotId ?? undefined,
        serialId: line.serialId ?? undefined,
      };
      if (input.disposition === "WRITE_OFF") return [issue];
      return [
        issue,
        {
          transactionType: "TRANSFER_IN",
          productVariantId: line.productVariantId,
          locationId: transfer.fromLocationId,
          quantityDelta: line.quantity,
          lotId: line.lotId ?? undefined,
          serialId: line.serialId ?? undefined,
          // The goods go back on the shelf at exactly what leaving transit
          // consumed, the same way a dispatch carries the source's cost into
          // transit. Estimating instead is exact under weighted average and
          // wrong under FIFO the moment an issue crosses a layer boundary,
          // which would quietly restate inventory on a return. A return emits
          // two movements per line, so the issue this one inherits from sits at
          // twice the line's index.
          costFromMovementIndex: lineIndex * 2,
        },
      ];
    });

    const posted = await this.engine.executeInTx(tx, orgId, userId, {
      // The outer claim owns `idempotencyKey`; the engine needs its own, derived
      // so a retry of this command replays rather than posting a second time.
      idempotencyKey: `transit-exit:${idempotencyKey}`,
      sourceType: "inv_transit_exit",
      sourceId: String(input.transferId),
      reason: `${input.disposition === "RETURN_TO_SOURCE" ? "Return to source" : "Abandoned in transit"}: ${input.reason}`,
      movements,
    });

    const remaining = remainingStranded(budgets);
    const nextStatus = await settleTransfer(
      tx,
      orgId,
      input.transferId,
      transfer.status,
      remaining,
    );

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action:
        input.disposition === "RETURN_TO_SOURCE"
          ? "inventory.transit.returned_to_source"
          : "inventory.transit.abandoned",
      resourceType: "inv_stock_transfers",
      resourceId: String(input.transferId),
      before: { status: transfer.status, strandedQuantity: totalTaken(lines, remaining) },
      after: { status: nextStatus, strandedQuantity: remaining },
      metadata: {
        disposition: input.disposition,
        reason: input.reason,
        transitLocationId,
        referenceNumber: transfer.referenceNumber,
        lines: lines.map((l) => ({
          transferLineId: l.transferLineId,
          productVariantId: l.productVariantId,
          quantity: l.quantity,
        })),
        transactionIds: posted.transactionIds,
        idempotencyKey,
      },
    });

    return {
      transferId: input.transferId,
      disposition: input.disposition,
      transitLocationId,
      lines: lines.map((l) => ({ transferLineId: l.transferLineId, quantity: l.quantity })),
      transactionIds: posted.transactionIds,
      transferStatus: nextStatus,
      strandedRemaining: remaining,
    };
  }

}
