import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../../stock-engine/idempotency";
import { InvStockTransfersService } from "../../stock/inv-stock-transfers.service";
import { fromExact, toExact } from "./exact";
import {
  TransferRecommendationService,
  type TransferRecommendation,
} from "./transfer-recommendation.service";
import type { ApproveTransferRecommendationInput } from "../dto/transfer-recommendation.schemas";

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
import {
  allocateFefo,
  destinationLocation,
  sourceLocation,
  type SourceAllocation,
} from "./lib/transfer-approval-bins";

/** Re-exported so importers of this service keep the path they had. */
export type { SourceAllocation } from "./lib/transfer-approval-bins";

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
    const fromLocationId = await sourceLocation(this.db, 
      orgId,
      input.productVariantId,
      input.fromWarehouseId,
    );
    const toLocationId = await destinationLocation(this.db, orgId, input.toWarehouseId);

    const quantity = toExact(recommendation.quantity);
    const allocations = await allocateFefo(this.db, 
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
