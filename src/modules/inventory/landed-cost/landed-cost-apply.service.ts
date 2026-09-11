import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  invGrns,
  invLandedCostAllocations,
  invLandedCostVouchers,
  invValuationLayers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import { runIdempotent } from "../stock-engine/idempotency";
import { centsToDecimal } from "./lib/apportion";
import { planLandedCost } from "./lib/landed-cost-plan";
import { postLandedCostJournal } from "./lib/landed-cost-journal";
import { type LandedCostBasis } from "./lib/layer-revaluation";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What one `apply` did, in the shape the caller and the replay both see. */
export interface LandedCostApplyResult {
  voucherId: number;
  status: "APPLIED";
  chargeTotal: string;
  capitalisedValue: string;
  expensedValue: string;
  layersRevalued: number;
}

/**
 * G5 — applying a landed-cost voucher.
 *
 * This is the whole answer to "the freight bill arrived after the goods".
 *
 * A receipt's cost is fixed before its ledger row is written: `plan` works it
 * out, the row is inserted already carrying it, and the append-only trigger then
 * refuses any change to `unit_cost` or `total_cost`. That is deliberate and it
 * is not being worked around here. What the receipt recorded on the day is a
 * fact and stays one.
 *
 * What moves is the *cost layer*. Layers are mutable by design — `commitIssue`
 * writes `remaining_quantity` on every issue — and the layer is what the next
 * issue draws its rate from, so raising a layer's `unit_cost` is precisely how a
 * later issue comes to consume the true cost rather than the invoice line.
 * Nothing here posts a stock movement, so on-hand does not change: the unit
 * calls that a valuation event rather than a silent adjustment, and it is one.
 *
 * The units that have already left cannot be reached. Their share of the freight
 * is expensed to COGS in the current period, recorded per layer so the split is
 * evidence rather than an assertion. When the voucher lands before anything has
 * been issued — the common case, and the one the unit's "done when" describes —
 * the expensed side is zero and every penny reaches the layers.
 *
 * Three things this deliberately refuses rather than guesses:
 *
 *   · a WEIGHTED_AVERAGE variant, because a later issue on that method costs at
 *     `inv_stock_levels.average_cost`, not at the layer, and moving the running
 *     average is a write to the stock engine's own projection;
 *   · a receipt with no cost layers, which means it was never posted;
 *   · a VALUE-basis voucher against a receipt worth nothing, where there is no
 *     defensible proportion to divide by.
 */
@Injectable()
export class LandedCostApplyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly audit: InventoryAuditService,
    private readonly accounting: InventoryAccountingBridge,
  ) {}

  async applyVoucher(
    orgId: string,
    userId: string,
    voucherId: number,
    idempotencyKey: string,
  ): Promise<LandedCostApplyResult> {
    const voucher = await this.db.query.invLandedCostVouchers.findFirst({
      where: and(
        eq(invLandedCostVouchers.orgId, orgId),
        eq(invLandedCostVouchers.id, voucherId),
      ),
      columns: { id: true, grnId: true, status: true },
    });
    if (!voucher) throw new NotFoundException("Landed-cost voucher not found");

    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, voucher.grnId), eq(invGrns.orgId, orgId)),
      columns: { id: true, grnNumber: true, status: true, locationId: true },
    });
    if (!grn) throw new NotFoundException("Goods receipt not found");
    await this.warehouseScope.assertLocationVisible(orgId, userId, grn.locationId);

    if (grn.status !== "POSTED") {
      throw new BadRequestException(
        "Landed cost can only be applied to a posted goods receipt — an unposted receipt has no cost layers to revalue",
      );
    }

    // The date the variance belongs to. Not the receipt's date: the share that
    // cannot capitalise is a cost of the month the invoice arrived in, and the
    // receipt's own month may be closed. Refused outright if this month is.
    const postingDate = new Date().toISOString().slice(0, 10);
    await this.accounting.assertOpen(orgId, postingDate);

    const applied = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.landed-cost.apply", voucherId },
        () => this.applyInTx(tx, orgId, userId, voucherId, grn.grnNumber, postingDate),
        (stored) => stored as LandedCostApplyResult,
      ),
    );

    await this.engine.invalidateCaches(orgId);
    return applied;
  }

  private async applyInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    voucherId: number,
    grnNumber: string,
    postingDate: string,
  ): Promise<LandedCostApplyResult> {
    // The lock before anything is read. Two applies of one voucher otherwise
    // both see DRAFT and both revalue, doubling the freight into the layers;
    // the status check below is only meaningful because the lock is held.
    const [locked] = await tx.execute<{
      status: string;
      grn_id: number;
      allocation_basis: LandedCostBasis;
      charge_total_cents: string;
    }>(sql`
      SELECT status, grn_id, allocation_basis, charge_total_cents
      FROM inv_landed_cost_vouchers
      WHERE id = ${voucherId} AND org_id = ${orgId}
      FOR UPDATE`);
    if (!locked) throw new NotFoundException("Landed-cost voucher not found");
    if (locked.status === "APPLIED")
      throw new ConflictException("This landed-cost voucher has already been applied");

    const chargeTotalCents = BigInt(locked.charge_total_cents);
    if (chargeTotalCents <= 0n)
      throw new BadRequestException("A landed-cost voucher with no charges cannot be applied");
    const chargeTotal = centsToDecimal(chargeTotalCents);

    // Everything that can refuse this voucher, and nothing that writes.
    // @see lib/landed-cost-plan.ts
    const plan = await planLandedCost(
      tx,
      orgId,
      locked.grn_id,
      locked.allocation_basis,
      chargeTotal,
    );

    let layersRevalued = 0;
    for (const row of plan.rows) {
      if (row.writesLayer) {
        layersRevalued += 1;
        await tx
          .update(invValuationLayers)
          .set({
            unitCost: row.unitCostAfter,
            totalValue: row.totalValueAfter,
            remainingValue: row.remainingValueAfter,
          })
          .where(
            and(
              eq(invValuationLayers.orgId, orgId),
              eq(invValuationLayers.id, row.layerId),
            ),
          );
      }

      await tx.insert(invLandedCostAllocations).values({
        orgId,
        voucherId,
        valuationLayerId: row.layerId,
        productVariantId: row.productVariantId,
        costingMethod: row.costingMethod,
        weight: row.weight,
        allocatedValue: row.allocated,
        capitalisedValue: row.capitalised,
        expensedValue: row.expensed,
        layerQuantity: row.layerQuantity,
        remainingQuantity: row.remainingQuantity,
        unitCostBefore: row.unitCostBefore,
        unitCostAfter: row.unitCostAfter,
      });
    }

    await tx
      .update(invLandedCostVouchers)
      .set({
        status: "APPLIED",
        capitalisedValue: plan.capitalisedTotal,
        expensedValue: plan.expensedTotal,
        appliedAt: new Date(),
        appliedBy: userId,
        updatedAt: new Date(),
      })
      .where(
        and(eq(invLandedCostVouchers.orgId, orgId), eq(invLandedCostVouchers.id, voucherId)),
      );

    await postLandedCostJournal(
      { accounting: this.accounting },
      orgId,
      userId,
      voucherId,
      grnNumber,
      postingDate,
      chargeTotal,
      plan,
    );

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "landed-cost.apply",
      resourceType: "inv_landed_cost_voucher",
      resourceId: String(voucherId),
      before: { status: "DRAFT" },
      after: { status: "APPLIED" },
      metadata: {
        grnNumber,
        basis: locked.allocation_basis,
        chargeTotal,
        capitalised: plan.capitalisedTotal,
        expensed: plan.expensedTotal,
        layersRevalued,
      },
    });

    return {
      voucherId,
      status: "APPLIED",
      chargeTotal,
      capitalisedValue: plan.capitalisedTotal,
      expensedValue: plan.expensedTotal,
      layersRevalued,
    };
  }
}
