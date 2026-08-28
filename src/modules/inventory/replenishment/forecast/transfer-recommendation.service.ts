import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { availableQtySumSql } from "../../stock-engine/available-sql";

export interface WarehousePosition {
  warehouseId: number;
  warehouseName: string;
  onHand: number;
  committed: number;
  available: number;
  /** Weekly demand measured at this warehouse. */
  weeklyDemand: number;
  /** Weeks of cover the available stock represents. Null when nothing sells here. */
  weeksOfCover: number | null;
}

export interface TransferRecommendation {
  fromWarehouseId: number;
  fromWarehouseName: string;
  toWarehouseId: number;
  toWarehouseName: string;
  quantity: number;
  /** Cover at each end after the move, so the trade is visible. */
  coverAfter: { from: number | null; to: number | null };
  rationale: string;
}

export interface TransferPlan {
  productVariantId: number;
  positions: WarehousePosition[];
  recommendations: TransferRecommendation[];
  caveats: string[];
}

/**
 * INV-308 — moving stock instead of buying it.
 *
 * The recommendation is worth making only when one site is short while another
 * genuinely has spare, and "spare" has to be measured in time rather than in
 * units. Two hundred units is a glut at a site selling five a week and a
 * fortnight's cover at one selling a hundred, so every comparison here is in
 * weeks of cover.
 *
 * Three rules the plan will not break:
 *
 *   **A donor is never stripped below its own target.** The failure mode this
 *   prevents is the obvious one: solving a stockout at one site by creating a
 *   stockout at another, which looks like progress on the report that
 *   recommended it.
 *
 *   **A site with no demand is never a recipient.** Stock that is not selling
 *   anywhere should not be moved to a site where it also will not sell; that
 *   is a transfer cost for no service improvement.
 *
 *   **Nothing is recommended below a floor.** Shipping four units between
 *   warehouses costs more than the stockout it averts, and a plan full of
 *   trivial moves is a plan nobody executes.
 */
@Injectable()
export class TransferRecommendationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /** Below this many units a move costs more than it saves. */
  private static readonly MIN_TRANSFER_UNITS = 5;
  /** A donor keeps at least this much cover for itself. */
  private static readonly DONOR_FLOOR_WEEKS = 4;
  /** A site is short when it holds less than this. */
  private static readonly RECIPIENT_TARGET_WEEKS = 2;

  async plan(
    orgId: string,
    userId: string,
    productVariantId: number,
    options: { weeks?: number } = {},
  ): Promise<TransferPlan> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty) {
      return {
        productVariantId,
        positions: [],
        recommendations: [],
        caveats: ["No warehouses are visible to this operator."],
      };
    }

    const weeks = options.weeks ?? 12;

    const rows = await this.db.execute<{
      warehouse_id: number;
      warehouse_name: string;
      on_hand: string;
      committed: string;
      available: string;
      demand: string;
    }>(sql`
      SELECT w.id AS warehouse_id,
             w.name AS warehouse_name,
             COALESCE(SUM(sl.on_hand), 0)::text AS on_hand,
             COALESCE(SUM(sl.committed), 0)::text AS committed,
             ${availableQtySumSql("sl")}::text AS available,
             COALESCE((
               SELECT SUM(-t.quantity_change)
               FROM inv_stock_transactions t
               JOIN inv_locations tl
                 ON tl.org_id = t.org_id AND tl.id = t.location_id
               WHERE t.org_id = ${orgId}
                 AND t.product_variant_id = ${productVariantId}
                 AND tl.warehouse_id = w.id
                 AND t.transaction_type IN ('SALE', 'RESERVATION_CONSUME')
                 AND t.quantity_change < 0
                 AND t.posting_date >= CURRENT_DATE - (${weeks} * 7)
             ), 0)::text AS demand
      FROM inv_warehouses w
      LEFT JOIN inv_locations l ON l.org_id = w.org_id AND l.warehouse_id = w.id
      LEFT JOIN inv_stock_levels sl
        ON sl.org_id = w.org_id
       AND sl.location_id = l.id
       AND sl.product_variant_id = ${productVariantId}
      WHERE w.org_id = ${orgId}
        AND w.is_active = true
        AND ${scope.warehouse(sql`w.id`)}
      GROUP BY w.id, w.name
      ORDER BY w.name
    `);

    const positions: WarehousePosition[] = rows.map((row) => {
      const onHand = Number(row.on_hand);
      const committed = Number(row.committed);
      // A1. One formula. A two-term copy here treated blocked, quality-held
      // and picked-not-shipped stock as transferable, so the plan would move
      // goods that were already spoken for.
      const available = Number(row.available);
      const weeklyDemand = Number(row.demand) / weeks;
      return {
        warehouseId: row.warehouse_id,
        warehouseName: row.warehouse_name,
        onHand,
        committed,
        available,
        weeklyDemand: Number(weeklyDemand.toFixed(4)),
        // Infinite cover is not a number, and reporting it as one makes every
        // idle site look like the best donor in the network.
        weeksOfCover: weeklyDemand > 0 ? Number((available / weeklyDemand).toFixed(2)) : null,
      };
    });

    const caveats: string[] = [];
    const recommendations: TransferRecommendation[] = [];

    // A site that sells nothing cannot be short of anything, so it is never a
    // recipient; it can still be a donor, and usually should be.
    const needy = positions
      .filter(
        (p) =>
          p.weeklyDemand > 0 &&
          p.weeksOfCover !== null &&
          p.weeksOfCover < TransferRecommendationService.RECIPIENT_TARGET_WEEKS,
      )
      .sort((a, b) => (a.weeksOfCover ?? 0) - (b.weeksOfCover ?? 0));

    // Spare, measured against what the donor needs for itself. A site with no
    // demand has all of its stock spare.
    const spareOf = (p: WarehousePosition) =>
      p.weeklyDemand === 0
        ? p.available
        : p.available -
          p.weeklyDemand * TransferRecommendationService.DONOR_FLOOR_WEEKS;

    const donors = positions
      .map((p) => ({ position: p, spare: spareOf(p) }))
      .filter((d) => d.spare >= TransferRecommendationService.MIN_TRANSFER_UNITS)
      .sort((a, b) => b.spare - a.spare);

    if (needy.length > 0 && donors.length === 0) {
      caveats.push(
        "One or more sites are short, but no site has spare stock to give without going short itself. This is a purchasing decision rather than a transfer.",
      );
    }

    for (const recipient of needy) {
      let stillNeeded =
        recipient.weeklyDemand *
          TransferRecommendationService.RECIPIENT_TARGET_WEEKS -
        recipient.available;

      for (const donor of donors) {
        if (stillNeeded < TransferRecommendationService.MIN_TRANSFER_UNITS) break;
        if (donor.position.warehouseId === recipient.warehouseId) continue;
        if (donor.spare < TransferRecommendationService.MIN_TRANSFER_UNITS) continue;

        const quantity = Math.floor(Math.min(donor.spare, stillNeeded));
        if (quantity < TransferRecommendationService.MIN_TRANSFER_UNITS) continue;

        donor.spare -= quantity;
        stillNeeded -= quantity;

        const donorAfter = donor.position.available - quantity;
        const recipientAfter = recipient.available + quantity;

        recommendations.push({
          fromWarehouseId: donor.position.warehouseId,
          fromWarehouseName: donor.position.warehouseName,
          toWarehouseId: recipient.warehouseId,
          toWarehouseName: recipient.warehouseName,
          quantity,
          coverAfter: {
            from:
              donor.position.weeklyDemand > 0
                ? Number((donorAfter / donor.position.weeklyDemand).toFixed(2))
                : null,
            to: Number((recipientAfter / recipient.weeklyDemand).toFixed(2)),
          },
          rationale:
            donor.position.weeklyDemand === 0
              ? `${donor.position.warehouseName} holds ${donor.position.available} units and sells none; ${recipient.warehouseName} has ${recipient.weeksOfCover} weeks of cover.`
              : `${donor.position.warehouseName} has ${donor.position.weeksOfCover} weeks of cover against ${recipient.warehouseName}'s ${recipient.weeksOfCover}.`,
        });
      }
    }

    return { productVariantId, positions, recommendations, caveats };
  }
}
