import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { availableQtySql, availableQtySumSql } from "../../stock-engine/available-sql";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../../stock-engine/idempotency";
import { InvStockTransfersService } from "../../stock/inv-stock-transfers.service";
import { cmpDec, subDec } from "../../stock-engine/decimal";
import { fromExact, toExact } from "./exact";
import {
  TransferRecommendationService,
  type TransferRecommendation,
} from "./transfer-recommendation.service";
import type { ApproveTransferRecommendationInput } from "../dto/transfer-recommendation.schemas";

/** One source lot, in the order FEFO wants it consumed. */
export interface SourceAllocation {
  lotId: number | null;
  lotNumber: string | null;
  expiryDate: string | null;
  /** Exact decimal string — what this lot contributes to the move. */
  quantity: string;
}

export interface ApprovedTransfer {
  transferId: number;
  referenceNumber: string;
  productVariantId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  fromLocationId: number;
  toLocationId: number;
  /** The server's quantity, re-derived. Never the caller's. */
  quantity: string;
  allocations: SourceAllocation[];
  /** Always PENDING: approving a recommendation does not hold the stock. */
  status: string;
  created: boolean;
}

/**
 * C5 — turning a recommendation into a transfer.
 *
 * Three properties this has to hold, and each is a way the obvious
 * implementation goes wrong:
 *
 * **The quantity is the server's.** The body names a move — variant, from, to —
 * and nothing else. The units are re-read from the plan at approval time, so a
 * recommendation that has been overtaken by a sale cannot be approved for the
 * amount it used to say. A client-sent quantity is rejected by the schema rather
 * than ignored, because a caller who sends one is asking for something this
 * endpoint will not do.
 *
 * **It never reserves.** `InvStockTransfersService.createTransfer` writes the
 * document and stops; reserving is a separate command with its own key and its
 * own permission. Approving a plan is a purchasing-style decision, not a hold on
 * stock, and a plan that quietly committed inventory at every site it touched
 * would make the recommendation screen unusable.
 *
 * **A second approve with the same key creates nothing.** `runIdempotent` claims
 * the key in the same transaction as the insert, so the retry replays the
 * original transfer id instead of raising a second document for the same move.
 * The request hash covers the *intent* — variant and endpoints — not the
 * recomputed quantity, because hashing a figure that legitimately moves between
 * the first call and its retry would turn every retry into a 422.
 */
@Injectable()
export class TransferApprovalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly recommendations: TransferRecommendationService,
    private readonly transfers: InvStockTransfersService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async approve(
    orgId: string,
    userId: string,
    input: ApproveTransferRecommendationInput,
    idempotencyKey: string,
  ): Promise<ApprovedTransfer> {
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.fromWarehouseId);
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.toWarehouseId);

    const recommendation = await this.findRecommendation(orgId, userId, input);
    const fromLocationId = await this.sourceLocation(
      orgId,
      input.productVariantId,
      input.fromWarehouseId,
    );
    const toLocationId = await this.destinationLocation(orgId, input.toWarehouseId);

    const quantity = toExact(recommendation.quantity);
    const allocations = await this.allocateFefo(
      orgId,
      input.productVariantId,
      fromLocationId,
      quantity,
    );

    const result = await this.db.transaction((tx) =>
      runIdempotent<CreatedTransfer>(
        tx,
        orgId,
        idempotencyKey,
        {
          command: "inventory.replenishment.transfer-recommendation.approve",
          productVariantId: input.productVariantId,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
        },
        async () => {
          // The existing transfer service, unchanged: it writes the document and
          // its lines and nothing else. There is no second stock path here.
          const transfer = await this.transfers.createTransfer(orgId, userId, {
            fromLocationId,
            toLocationId,
            fromWarehouseId: input.fromWarehouseId,
            toWarehouseId: input.toWarehouseId,
            notes: input.notes ?? recommendation.rationale.slice(0, 1000),
            lines: allocations.map((allocation) => ({
              productVariantId: input.productVariantId,
              quantity: fromExact(allocation.quantity),
              ...(allocation.lotId === null ? {} : { lotId: allocation.lotId }),
            })),
          }, `${idempotencyKey}:transfer`);
          return {
            transferId: transfer.id,
            referenceNumber: transfer.referenceNumber,
            status: String(transfer.status),
            created: true,
          };
        },
        reviveTransfer,
      ),
    );

    return {
      transferId: result.transferId,
      referenceNumber: result.referenceNumber,
      productVariantId: input.productVariantId,
      fromWarehouseId: input.fromWarehouseId,
      toWarehouseId: input.toWarehouseId,
      fromLocationId,
      toLocationId,
      quantity,
      allocations,
      status: result.status,
      created: result.created,
    };
  }

  private async findRecommendation(
    orgId: string,
    userId: string,
    input: ApproveTransferRecommendationInput,
  ): Promise<TransferRecommendation> {
    const plan = await this.recommendations.plan(orgId, userId, input.productVariantId, {
      ...(input.weeks === undefined ? {} : { weeks: input.weeks }),
    });
    const match = plan.recommendations.find(
      (r) =>
        r.fromWarehouseId === input.fromWarehouseId &&
        r.toWarehouseId === input.toWarehouseId,
    );
    if (!match) {
      throw new BadRequestException(
        "This move is no longer recommended — the position at one of the two sites has moved since the plan was read.",
      );
    }
    return match;
  }

  /**
   * Where the goods leave from.
   *
   * A transfer document names one source location, so the whole move comes out
   * of the bin with the most sellable stock rather than being spread across
   * every bin in the warehouse. `availableQtySumSql` is the one availability
   * formula (`available-sql.ts`), so blocked, quality-held and picked stock is
   * already out of this number.
   */
  private async sourceLocation(
    orgId: string,
    productVariantId: number,
    warehouseId: number,
  ): Promise<number> {
    const [row] = await this.db.execute<{ location_id: number }>(sql`
      SELECT l.id AS location_id
      FROM inv_locations l
      JOIN inv_stock_levels sl
        ON sl.org_id = l.org_id
       AND sl.location_id = l.id
       AND sl.product_variant_id = ${productVariantId}
      WHERE l.org_id = ${orgId}
        AND l.warehouse_id = ${warehouseId}
        AND l.is_active = true
      GROUP BY l.id
      HAVING ${availableQtySumSql("sl")} > 0
      ORDER BY ${availableQtySumSql("sl")} DESC, l.id
      LIMIT 1
    `);
    if (!row) {
      throw new BadRequestException(
        "The donor warehouse has no unheld stock of this item to send.",
      );
    }
    return Number(row.location_id);
  }

  private async destinationLocation(orgId: string, warehouseId: number): Promise<number> {
    const [row] = await this.db.execute<{ id: number }>(sql`
      SELECT id FROM inv_locations
      WHERE org_id = ${orgId}
        AND warehouse_id = ${warehouseId}
        AND is_active = true
        AND is_sellable IS NOT FALSE
      ORDER BY id
      LIMIT 1
    `);
    if (!row) {
      throw new BadRequestException(
        "The receiving warehouse has no active sellable location to receive into.",
      );
    }
    return Number(row.id);
  }

  /**
   * Which lots go, in FEFO order.
   *
   * Earliest expiry first, un-lotted stock last: sending the freshest lot and
   * leaving the one that expires next month behind is how a network with spare
   * stock still writes it off. A lot on quality hold contributes nothing here
   * because `availableQtySql` has already subtracted the held quantity, so the
   * hold is respected without a second rule that could disagree with the first.
   */
  private async allocateFefo(
    orgId: string,
    productVariantId: number,
    locationId: number,
    quantity: string,
  ): Promise<SourceAllocation[]> {
    const rows = await this.db.execute<{
      lot_id: number | null;
      lot_number: string | null;
      expiry_date: string | null;
      available: string;
    }>(sql`
      SELECT sl.lot_id,
             lot.lot_number,
             lot.expiry_date::text AS expiry_date,
             ${availableQtySql("sl")}::text AS available
      FROM inv_stock_levels sl
      LEFT JOIN inv_lots lot ON lot.org_id = sl.org_id AND lot.id = sl.lot_id
      WHERE sl.org_id = ${orgId}
        AND sl.product_variant_id = ${productVariantId}
        AND sl.location_id = ${locationId}
        AND (lot.id IS NULL OR lot.status = 'ACTIVE')
      ORDER BY lot.expiry_date ASC NULLS LAST, sl.lot_id ASC NULLS LAST, sl.id
    `);

    const allocations: SourceAllocation[] = [];
    let outstanding = quantity;

    for (const row of rows) {
      if (cmpDec(outstanding, "0") <= 0) break;
      const available = row.available;
      if (cmpDec(available, "0") <= 0) continue;
      const take = cmpDec(available, outstanding) < 0 ? available : outstanding;
      allocations.push({
        lotId: row.lot_id === null ? null : Number(row.lot_id),
        lotNumber: row.lot_number,
        expiryDate: row.expiry_date,
        quantity: take,
      });
      outstanding = subDec(outstanding, take);
    }

    if (allocations.length === 0 || cmpDec(outstanding, "0") > 0) {
      throw new BadRequestException(
        "The donor warehouse no longer holds enough unheld stock to cover this move.",
      );
    }
    return allocations;
  }
}

interface CreatedTransfer {
  transferId: number;
  referenceNumber: string;
  status: string;
  created: boolean;
}

/**
 * The stored response has been through `jsonb`, so it is rebuilt field by field
 * rather than cast. `created` is false on this path by definition: a replay is
 * the answer to a request that already ran.
 */
function reviveTransfer(stored: unknown): CreatedTransfer {
  const row =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  return {
    transferId: Number(row.transferId ?? 0),
    referenceNumber: String(row.referenceNumber ?? ""),
    status: String(row.status ?? "PENDING"),
    created: false,
  };
}
