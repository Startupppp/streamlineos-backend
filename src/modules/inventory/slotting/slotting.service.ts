import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { invSlottingRecommendations, invSlottingRules } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { classifyVelocity, rankBySlot, type SlottedSuggestion } from "./slotting-rules";
import type { PutawaySuggestion } from "../warehouses/putaway-suggestion";
import type {
  CreateSlottingRuleInput,
  ListRecommendationsQuery,
} from "./dto/slotting.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The default classification window. A quarter of picking, which is what a season is. */
const VELOCITY_WINDOW_DAYS = 90;

export interface SlotTarget {
  locationIds: ReadonlySet<number>;
  ruleName: string | null;
}

export interface ReslotSweepResult {
  organizations: number;
  succeeded: number;
  failed: number;
}

/**
 * NEO-6 - where a SKU belongs, and what to do when it is somewhere else.
 *
 * Three things, and the separation between them is the design:
 *
 *   * **Rules** say where a class of SKU should live. Written by a planner.
 *   * **Velocity** says which class a SKU is in. Derived from the ledger on a
 *     window, never typed - a class somebody entered last March is a class that
 *     is now wrong.
 *   * **Recommendations** say where stock actually is and where the rules put
 *     it. Generated read-only; approving one raises an ordinary transfer.
 *
 * Nothing here moves stock. A warehouse that rearranges itself overnight is one
 * where a picker's memory of yesterday is a liability, and the supervisor who
 * answers for the labour is the person who should decide whether it is worth it.
 */
@Injectable()
export class SlottingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /* ---------------------------------------------------------------- *
   * Rules
   * ---------------------------------------------------------------- */

  async listRules(orgId: string, userId: string, warehouseId?: number) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [eq(invSlottingRules.orgId, orgId)];
    if (warehouseId) conditions.push(eq(invSlottingRules.warehouseId, warehouseId));
    if (scope !== null) {
      conditions.push(
        scope.length === 0
          ? sql`FALSE`
          : sql`${invSlottingRules.warehouseId} IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`,
      );
    }

    return this.db
      .select()
      .from(invSlottingRules)
      .where(and(...conditions))
      .orderBy(asc(invSlottingRules.priority), asc(invSlottingRules.id));
  }

  async createRule(orgId: string, userId: string, input: CreateSlottingRuleInput) {
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);

    const [rule] = await this.db
      .insert(invSlottingRules)
      .values({
        orgId,
        warehouseId: input.warehouseId,
        name: input.name,
        matchType: input.matchType,
        velocityClass: input.velocityClass ?? null,
        categoryId: input.categoryId ?? null,
        productVariantId: input.productVariantId ?? null,
        targetZoneLocationId: input.targetZoneLocationId,
        targetLocationType: input.targetLocationType ?? null,
        priority: input.priority,
        isActive: true,
        createdBy: userId,
      })
      .returning();

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "slotting_rule.create",
      resourceType: "inv_slotting_rule",
      resourceId: String(rule!.id),
      after: { name: input.name, matchType: input.matchType, priority: input.priority },
    });

    return rule;
  }

  async setRuleActive(orgId: string, userId: string, ruleId: number, isActive: boolean) {
    const [rule] = await this.db
      .update(invSlottingRules)
      .set({ isActive, updatedAt: new Date() })
      .where(and(eq(invSlottingRules.orgId, orgId), eq(invSlottingRules.id, ruleId)))
      .returning();
    if (!rule) throw new NotFoundException("Not found");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: isActive ? "slotting_rule.enable" : "slotting_rule.disable",
      resourceType: "inv_slotting_rule",
      resourceId: String(ruleId),
      after: { isActive },
    });
    return rule;
  }

  /* ---------------------------------------------------------------- *
   * The slot a SKU belongs in
   * ---------------------------------------------------------------- */

  /**
   * The bins the rules point at for one SKU in one warehouse.
   *
   * Returns an empty set when no rule matches, which is what makes this
   * backwards-compatible: `rankBySlot` then degrades to exactly the INV-202
   * order, and an organisation that has written no rules sees no change at all.
   *
   * The zone is expanded to its descendant bins with a recursive walk rather than
   * by naming bins on the rule, because a rule that names bins is wrong the
   * moment one of them is full.
   */
  async slotFor(
    executor: Tx | Db,
    orgId: string,
    params: { warehouseId: number; productVariantId: number },
  ): Promise<SlotTarget> {
    const [rule] = await executor.execute<{ id: number; name: string; target_zone_location_id: number; target_location_type: string | null }>(sql`
      SELECT r.id, r.name, r.target_zone_location_id, r.target_location_type
      FROM inv_slotting_rules r
      LEFT JOIN inv_velocity_classes v
        ON v.org_id = r.org_id
       AND v.warehouse_id = r.warehouse_id
       AND v.product_variant_id = ${params.productVariantId}
      LEFT JOIN inv_product_variants pv
        ON pv.org_id = r.org_id AND pv.id = ${params.productVariantId}
      LEFT JOIN inv_products p
        ON p.org_id = pv.org_id AND p.id = pv.product_id
      WHERE r.org_id = ${orgId}
        AND r.warehouse_id = ${params.warehouseId}
        AND r.is_active = true
        AND (
          (r.match_type = 'PRODUCT_VARIANT' AND r.product_variant_id = ${params.productVariantId})
          OR (r.match_type = 'CATEGORY' AND r.category_id = p.category_id)
          OR (r.match_type = 'VELOCITY_CLASS' AND r.velocity_class = v.velocity_class)
        )
      ORDER BY r.priority ASC, r.id ASC
      LIMIT 1
    `);

    if (!rule) return { locationIds: new Set<number>(), ruleName: null };

    const bins = await executor.execute<{ id: number }>(sql`
      WITH RECURSIVE zone AS (
        SELECT id, parent_location_id, location_type, 1 AS depth
        FROM inv_locations
        WHERE org_id = ${orgId} AND id = ${rule.target_zone_location_id}
        UNION ALL
        SELECT l.id, l.parent_location_id, l.location_type, zone.depth + 1
        FROM inv_locations l
        JOIN zone ON l.parent_location_id = zone.id
        WHERE l.org_id = ${orgId} AND zone.depth < 16
      )
      SELECT id FROM zone
      WHERE ${rule.target_location_type === null ? sql`TRUE` : sql`location_type = ${rule.target_location_type}`}
    `);

    return {
      locationIds: new Set(bins.map((b) => Number(b.id))),
      ruleName: rule.name,
    };
  }

  /** The re-rank putaway applies. Pure ordering lives in `slotting-rules.ts`. */
  async rankSuggestions(
    orgId: string,
    params: { warehouseId: number; productVariantId: number },
    suggestions: readonly PutawaySuggestion[],
  ): Promise<SlottedSuggestion[]> {
    const slot = await this.slotFor(this.db, orgId, params);
    return rankBySlot(suggestions, slot);
  }

  /* ---------------------------------------------------------------- *
   * Velocity
   * ---------------------------------------------------------------- */

  /**
   * Recompute ABC for one warehouse from the ledger.
   *
   * Counts *lines*, not units: slotting is about walks, and a SKU picked a
   * hundred times in ones costs a hundred journeys where one picked once in
   * hundreds costs one.
   */
  async recomputeVelocity(
    executor: Tx | Db,
    orgId: string,
    warehouseId: number,
    windowDays = VELOCITY_WINDOW_DAYS,
  ): Promise<number> {
    const rows = await executor.execute<{
      product_variant_id: number; pick_count: number; issued_qty: string;
    }>(sql`
      SELECT t.product_variant_id,
             COUNT(*)::int AS pick_count,
             COALESCE(SUM(ABS(t.quantity_change)), 0)::text AS issued_qty
      FROM inv_stock_transactions t
      JOIN inv_locations l ON l.org_id = t.org_id AND l.id = t.location_id
      WHERE t.org_id = ${orgId}
        AND l.warehouse_id = ${warehouseId}
        AND t.quantity_change < 0
        AND t.quantity_bucket = 'ON_HAND'
        AND t.created_at >= now() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY t.product_variant_id
    `);

    const classified = classifyVelocity(
      rows.map((r) => ({
        productVariantId: Number(r.product_variant_id),
        pickCount: Number(r.pick_count),
        issuedQty: String(r.issued_qty),
      })),
    );

    for (const row of classified) {
      await executor.execute(sql`
        INSERT INTO inv_velocity_classes
          (org_id, warehouse_id, product_variant_id, velocity_class, pick_count, issued_qty, window_days, computed_at)
        VALUES (${orgId}, ${warehouseId}, ${row.productVariantId}, ${row.velocityClass},
                ${row.pickCount}, ${row.issuedQty}::numeric, ${windowDays}, now())
        ON CONFLICT (org_id, warehouse_id, product_variant_id)
        DO UPDATE SET velocity_class = EXCLUDED.velocity_class,
                      pick_count = EXCLUDED.pick_count,
                      issued_qty = EXCLUDED.issued_qty,
                      window_days = EXCLUDED.window_days,
                      computed_at = now()
      `);
    }

    return classified.length;
  }

  /* ---------------------------------------------------------------- *
   * Re-slot recommendations
   * ---------------------------------------------------------------- */

  /**
   * Compare where stock stands against where the rules put it, and record the
   * difference. **Writes no stock and creates no task.**
   *
   * `ON CONFLICT DO NOTHING` against the open-recommendation index is what stops
   * a nightly job burying the ones nobody has looked at yet under identical
   * copies of themselves.
   */
  async generateRecommendations(
    executor: Tx | Db,
    orgId: string,
    warehouseId: number,
  ): Promise<number> {
    const misplaced = await executor.execute<{
      product_variant_id: number; from_location_id: number; quantity: string;
      rule_id: number; rule_name: string; zone_id: number;
    }>(sql`
      SELECT sl.product_variant_id,
             sl.location_id AS from_location_id,
             SUM(sl.on_hand)::text AS quantity,
             r.id AS rule_id,
             r.name AS rule_name,
             r.target_zone_location_id AS zone_id
      FROM inv_stock_levels sl
      JOIN inv_locations l ON l.org_id = sl.org_id AND l.id = sl.location_id
      JOIN inv_product_variants pv ON pv.org_id = sl.org_id AND pv.id = sl.product_variant_id
      JOIN inv_products p ON p.org_id = pv.org_id AND p.id = pv.product_id
      LEFT JOIN inv_velocity_classes v
        ON v.org_id = sl.org_id AND v.warehouse_id = l.warehouse_id
       AND v.product_variant_id = sl.product_variant_id
      JOIN LATERAL (
        SELECT r2.id, r2.name, r2.target_zone_location_id
        FROM inv_slotting_rules r2
        WHERE r2.org_id = sl.org_id
          AND r2.warehouse_id = l.warehouse_id
          AND r2.is_active = true
          AND (
            (r2.match_type = 'PRODUCT_VARIANT' AND r2.product_variant_id = sl.product_variant_id)
            OR (r2.match_type = 'CATEGORY' AND r2.category_id = p.category_id)
            OR (r2.match_type = 'VELOCITY_CLASS' AND r2.velocity_class = v.velocity_class)
          )
        ORDER BY r2.priority ASC, r2.id ASC
        LIMIT 1
      ) r ON TRUE
      WHERE sl.org_id = ${orgId}
        AND l.warehouse_id = ${warehouseId}
        AND sl.on_hand > 0
        AND l.is_sellable IS NOT FALSE
        -- Already in the right zone: nothing to recommend. The walk is the
        -- recursive descent from the rule's zone down to the bins under it.
        AND NOT EXISTS (
          WITH RECURSIVE zone AS (
            SELECT id, 1 AS depth FROM inv_locations
             WHERE org_id = sl.org_id AND id = r.target_zone_location_id
            UNION ALL
            SELECT c.id, zone.depth + 1 FROM inv_locations c
              JOIN zone ON c.parent_location_id = zone.id
             WHERE c.org_id = sl.org_id AND zone.depth < 16
          )
          SELECT 1 FROM zone WHERE zone.id = sl.location_id
        )
      GROUP BY sl.product_variant_id, sl.location_id, r.id, r.name, r.target_zone_location_id
    `);

    let written = 0;
    for (const row of misplaced) {
      const result = await executor.execute(sql`
        INSERT INTO inv_slotting_recommendations
          (org_id, warehouse_id, product_variant_id, from_location_id, to_zone_location_id,
           quantity, rule_id, reason, status)
        VALUES (${orgId}, ${warehouseId}, ${row.product_variant_id}, ${row.from_location_id},
                ${row.zone_id}, ${row.quantity}::numeric, ${row.rule_id},
                ${`Rule "${row.rule_name}" puts this SKU in another zone`}, 'PENDING')
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      written += result.length;
    }

    return written;
  }

  /**
   * The nightly sweep, one organisation at a time.
   *
   * `forEachOrg` because a background sweep has no ambient tenant context and a
   * cross-org discovery query is denied under RLS (backend/CLAUDE.md S4). Each
   * organisation's failure is isolated: the loop continues.
   */
  async runReslotSweep(): Promise<ReslotSweepResult> {
    const result = await forEachOrg(this.db, "inventory-reslot", async (tx, orgId) => {
      const warehouses = await tx.execute<{ id: number }>(sql`
        SELECT id FROM inv_warehouses WHERE org_id = ${orgId} AND is_active = true ORDER BY id
      `);
      for (const warehouse of warehouses) {
        const warehouseId = Number(warehouse.id);
        await this.recomputeVelocity(tx as unknown as Tx, orgId, warehouseId);
        await this.generateRecommendations(tx as unknown as Tx, orgId, warehouseId);
      }
    });
    return result;
  }

  async listRecommendations(orgId: string, userId: string, query: ListRecommendationsQuery) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [
      eq(invSlottingRecommendations.orgId, orgId),
      sql`${invSlottingRecommendations.status} = ${query.status}`,
    ];
    if (query.warehouseId) conditions.push(eq(invSlottingRecommendations.warehouseId, query.warehouseId));
    if (scope !== null) {
      conditions.push(
        scope.length === 0
          ? sql`FALSE`
          : sql`${invSlottingRecommendations.warehouseId} IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`,
      );
    }

    return this.db
      .select()
      .from(invSlottingRecommendations)
      .where(and(...conditions))
      .orderBy(desc(invSlottingRecommendations.createdAt), desc(invSlottingRecommendations.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
  }

  /**
   * Dismiss a recommendation. Touches nothing but the row.
   *
   * Kept rather than deleted: "we looked at this and decided not to" is a fact,
   * and the alternative is the sweep proposing the same move again tomorrow.
   */
  async dismiss(orgId: string, userId: string, recommendationId: number, reason?: string) {
    const [row] = await this.db
      .update(invSlottingRecommendations)
      .set({ status: "DISMISSED", decidedBy: userId, decidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invSlottingRecommendations.orgId, orgId),
          eq(invSlottingRecommendations.id, recommendationId),
          sql`${invSlottingRecommendations.status} = 'PENDING'`,
        ),
      )
      .returning();
    if (!row) throw new NotFoundException("Not found");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "slotting_recommendation.dismiss",
      resourceType: "inv_slotting_recommendation",
      resourceId: String(recommendationId),
      after: { status: "DISMISSED" },
      metadata: reason ? { reason } : null,
    });
    return row;
  }

  /**
   * Approve one, and hand back the transfer it needs.
   *
   * This marks the decision and names the bin; it does **not** post the move.
   * The caller raises an ordinary transfer through `InvStockService`, so a
   * re-slot is a ledger fact like any other rather than a special case with its
   * own posting path - which is how a second stock engine starts.
   */
  async approve(
    orgId: string,
    userId: string,
    recommendationId: number,
    toLocationId: number,
  ) {
    const [row] = await this.db
      .select()
      .from(invSlottingRecommendations)
      .where(
        and(
          eq(invSlottingRecommendations.orgId, orgId),
          eq(invSlottingRecommendations.id, recommendationId),
        ),
      );
    if (!row) throw new NotFoundException("Not found");
    if (row.status !== "PENDING") {
      throw new BadRequestException(`This recommendation is already ${row.status.toLowerCase()}`);
    }

    await this.warehouseScope.assertLocationVisible(orgId, userId, toLocationId);

    const [updated] = await this.db
      .update(invSlottingRecommendations)
      .set({ status: "APPROVED", decidedBy: userId, decidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invSlottingRecommendations.orgId, orgId),
          eq(invSlottingRecommendations.id, recommendationId),
          sql`${invSlottingRecommendations.status} = 'PENDING'`,
        ),
      )
      .returning();
    if (!updated) throw new BadRequestException("This recommendation was decided by somebody else");

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "slotting_recommendation.approve",
      resourceType: "inv_slotting_recommendation",
      resourceId: String(recommendationId),
      after: { status: "APPROVED", toLocationId },
    });

    return {
      recommendation: updated,
      /** What the caller must transfer, so the move is an ordinary command. */
      move: {
        productVariantId: row.productVariantId,
        fromLocationId: row.fromLocationId,
        toLocationId,
        quantity: row.quantity,
      },
    };
  }
}
