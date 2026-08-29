import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
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
import { addDec, cmpDec, isPositive } from "../stock-engine/decimal";
import { runIdempotent } from "../stock-engine/idempotency";
import { centsToDecimal } from "./lib/apportion";
import {
  planRevaluation,
  type LandedCostBasis,
  type LayerSnapshot,
  type RevaluationPlan,
} from "./lib/layer-revaluation";

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

interface LayerRow extends Record<string, unknown> {
  id: number;
  product_variant_id: number;
  costing_method: string;
  quantity: string;
  unit_cost: string;
  total_value: string;
  remaining_quantity: string;
  remaining_value: string;
}

/** Inventory. The receipt already debited it; landed cost adds to it. */
const INVENTORY_ACCOUNT = "1300";
/**
 * Cost of goods sold. Freight on units that have already been issued belongs
 * here and not in inventory: those units are gone, their sale is already booked
 * at the old cost, and the append-only ledger means that sale's COGS cannot be
 * restated. The difference lands in the period the carrier's invoice did.
 */
const COGS_ACCOUNT = "5000";
/** Accounts payable, the same credit side the receipt itself used. */
const PAYABLE_ACCOUNT = "2000";

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

    const layers = await this.lockReceiptLayers(tx, orgId, locked.grn_id);
    if (layers.length === 0) {
      throw new UnprocessableEntityException(
        "This goods receipt produced no cost layers, so there is nothing to land a cost onto",
      );
    }

    const averaged = layers.filter((layer) => layer.costingMethod === "WEIGHTED_AVERAGE");
    if (averaged.length > 0) {
      // Refused loudly rather than mis-costed quietly. On weighted average the
      // issue path draws at `inv_stock_levels.average_cost` and never looks at
      // the layer, so revaluing the layer here would look entirely successful,
      // change the valuation report, and leave every subsequent issue costing at
      // the old average — the worst of the three possible outcomes.
      throw new UnprocessableEntityException(
        `Landed cost is not yet supported for weighted-average variants (${averaged.length} of ${layers.length} layers on this receipt): applying it would revalue the layers without moving the running average that issues actually cost at`,
      );
    }

    const weightTotal = layers.reduce(
      (sum, layer) =>
        addDec(sum, locked.allocation_basis === "VALUE" ? layer.totalValue : layer.quantity),
      "0.0000",
    );
    if (!isPositive(weightTotal)) {
      throw new UnprocessableEntityException(
        locked.allocation_basis === "VALUE"
          ? "This receipt's cost layers are worth nothing, so a value-based allocation has no proportion to divide by — raise the voucher on the QUANTITY basis"
          : "This receipt's cost layers hold no quantity, so a quantity-based allocation has no proportion to divide by",
      );
    }

    const plan = planRevaluation(chargeTotal, locked.allocation_basis, layers);
    this.assertNothingLost(chargeTotal, plan);

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

    await this.postJournal(orgId, userId, voucherId, grnNumber, postingDate, chargeTotal, plan);

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

  /**
   * The receipt's cost layers, locked in the order the issue path locks them.
   *
   * `FOR UPDATE` so an issue cannot consume a layer between the snapshot this
   * plans against and the write that revalues it — otherwise a concurrent
   * shipment would draw at the old rate while this decided that quantity was
   * still in stock, and the freight would capitalise onto units that had already
   * gone. `ORDER BY created_at, id` matches `lockConsumableLayers` exactly: two
   * transactions taking the same rows in the same order queue instead of
   * deadlocking.
   */
  private async lockReceiptLayers(
    tx: Tx,
    orgId: string,
    grnId: number,
  ): Promise<LayerSnapshot[]> {
    const rows = await tx.execute<LayerRow>(sql`
      SELECT id, product_variant_id, costing_method, quantity, unit_cost,
             total_value, remaining_quantity, remaining_value
      FROM inv_valuation_layers
      WHERE org_id = ${orgId}
        AND source_type = 'inv_grn'
        AND source_id = ${String(grnId)}
      ORDER BY created_at ASC, id ASC
      FOR UPDATE`);

    return rows.map((row) => ({
      id: Number(row.id),
      productVariantId: Number(row.product_variant_id),
      costingMethod: String(row.costing_method),
      quantity: String(row.quantity),
      unitCost: String(row.unit_cost),
      totalValue: String(row.total_value),
      remainingQuantity: String(row.remaining_quantity),
      remainingValue: String(row.remaining_value),
    }));
  }

  /**
   * The one identity this feature claims: nothing the voucher charged is lost
   * between the invoice and the layers.
   *
   * Checked here rather than trusted, because every failure mode of an
   * apportionment is silent — a lost ten-thousandth does not throw, it just
   * leaves the general ledger unbalanced by an amount too small to notice per
   * voucher and exactly large enough to make a month-end reconciliation
   * unexplainable.
   */
  private assertNothingLost(chargeTotal: string, plan: RevaluationPlan): void {
    const accounted = addDec(plan.capitalisedTotal, plan.expensedTotal);
    if (cmpDec(accounted, chargeTotal) !== 0) {
      throw new UnprocessableEntityException(
        `Landed-cost apportionment did not balance: ${chargeTotal} charged, ${accounted} allocated`,
      );
    }
  }

  /**
   * The accounting entry, posted inside the voucher's own transaction for the
   * same reason the receipt's is: stock and the general ledger can then never
   * disagree, and a deferred failure would have no idempotency claim of its own
   * once this one has committed.
   *
   * Three lines rather than two, because the two halves land in different places:
   * what capitalised is inventory, what could not is this period's cost of sales.
   * A zero line is omitted rather than posted, so the common case — the invoice
   * arriving before anything shipped — reads as the two-line entry it is.
   *
   * `postJournalEntry` skips with a warning when accounting is not migrated or
   * the tenant has no chart of accounts. That property is inherited deliberately:
   * a warehouse that has never configured account 1300 must still be able to land
   * a freight cost on its stock.
   */
  private async postJournal(
    orgId: string,
    userId: string,
    voucherId: number,
    grnNumber: string,
    postingDate: string,
    chargeTotal: string,
    plan: RevaluationPlan,
  ): Promise<void> {
    const capitalised = Number(plan.capitalisedTotal);
    const expensed = Number(plan.expensedTotal);
    const total = Number(chargeTotal);
    if (total <= 0) return;

    const lines: Array<{
      accountCode: string;
      debit: number;
      credit: number;
      description: string;
    }> = [];
    if (capitalised > 0) {
      lines.push({
        accountCode: INVENTORY_ACCOUNT,
        debit: capitalised,
        credit: 0,
        description: `Landed cost capitalised - ${grnNumber}`,
      });
    }
    if (expensed > 0) {
      lines.push({
        accountCode: COGS_ACCOUNT,
        debit: expensed,
        credit: 0,
        description: `Landed cost on goods already issued - ${grnNumber}`,
      });
    }
    lines.push({
      accountCode: PAYABLE_ACCOUNT,
      debit: 0,
      credit: total,
      description: `Landed cost payable - ${grnNumber}`,
    });

    await this.accounting.postJournalEntry({
      orgId,
      entryDate: postingDate,
      description: `Landed cost applied: ${grnNumber}`,
      sourceType: "inv_landed_cost",
      sourceId: String(voucherId),
      sourceEvent: "apply",
      status: "POSTED",
      createdBy: userId,
      lines,
    });
  }
}
