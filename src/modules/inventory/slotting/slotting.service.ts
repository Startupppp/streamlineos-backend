import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { invSlottingRecommendations, invSlottingRules } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import { rankBySlot, type SlottedSuggestion } from "./slotting-rules";
import type { PutawaySuggestion } from "../warehouses/putaway-suggestion";
import type {
  CreateSlottingRuleInput,
  ListRecommendationsQuery,
} from "./dto/slotting.schemas";
import { generateRecommendations, recomputeVelocity } from "./lib/slotting-sweep";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The default classification window. A quarter of picking, which is what a season is. */

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

  /**
   * Which slotting rules this caller may see — the list's rule, now the only
   * copy.
   *
   * A rule names its warehouse directly and NOT NULL, so this is the plain
   * column predicate and there is no null case to decide: every rule belongs to
   * exactly one building. Both readings of the scope used to be spelled out by
   * hand here and in `listRecommendations`, and the command beside each was
   * simply never told — which is why they are one method each now.
   */
  private ruleInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.warehouse(sql`${invSlottingRules.warehouseId}`);
  }

  /** The same, for a recommendation. Also a NOT NULL warehouse column. */
  private recommendationInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.warehouse(sql`${invSlottingRecommendations.warehouseId}`);
  }

  async listRules(orgId: string, userId: string, warehouseId?: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const conditions = [eq(invSlottingRules.orgId, orgId)];
    if (warehouseId) conditions.push(eq(invSlottingRules.warehouseId, warehouseId));
    conditions.push(this.ruleInScope(scope));

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

  /**
   * Turn a rule on or off.
   *
   * `listRules` above narrows to the caller's buildings and `createRule` asserts
   * the one it writes into; this reached the row on `org_id` and the id alone,
   * so a supervisor holding no part of a warehouse could disable its slotting
   * policy.
   *
   * Nothing downstream would have caught it. A rule toggle posts no stock, so
   * the engine's `assertLocationsInScope` never runs on this path; the damage is
   * quiet and arrives later, through `slotFor` — every putaway in that building
   * silently stops being ranked by the policy somebody wrote, and the goods go
   * to whatever bin the generic suggestion offers.
   *
   * The predicate rides the UPDATE, so there is no window between a check and
   * the write. No row matched is 404, never 403 (§4).
   */
  async setRuleActive(orgId: string, userId: string, ruleId: number, isActive: boolean) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [rule] = await this.db
      .update(invSlottingRules)
      .set({ isActive, updatedAt: new Date() })
      .where(
        and(
          eq(invSlottingRules.orgId, orgId),
          eq(invSlottingRules.id, ruleId),
          this.ruleInScope(scope),
        ),
      )
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
        await recomputeVelocity(tx as unknown as Tx, orgId, warehouseId);
        await generateRecommendations(tx as unknown as Tx, orgId, warehouseId);
      }
    });
    return result;
  }

  async listRecommendations(orgId: string, userId: string, query: ListRecommendationsQuery) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const conditions = [
      eq(invSlottingRecommendations.orgId, orgId),
      sql`${invSlottingRecommendations.status} = ${query.status}`,
    ];
    if (query.warehouseId) conditions.push(eq(invSlottingRecommendations.warehouseId, query.warehouseId));
    conditions.push(this.recommendationInScope(scope));

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
    /*
     * Scoped like `list` and `approve` already are. `approve` gained its gate
     * because approving ends with stock moving; dismissing was left because it
     * "touches nothing but the row", and that reading is the mistake. The row is
     * the decision: a stranger dismissing another building's re-slot removes it
     * from the supervisor's queue there, and the sweep will not propose it again
     * because DISMISSED is exactly the state that says somebody looked. It also
     * stamps `decided_by` with a person who never saw it.
     *
     * On the UPDATE rather than in front of it, so the scope and the PENDING
     * status are settled by one statement. 404, never 403.
     */
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [row] = await this.db
      .update(invSlottingRecommendations)
      .set({ status: "DISMISSED", decidedBy: userId, decidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invSlottingRecommendations.orgId, orgId),
          eq(invSlottingRecommendations.id, recommendationId),
          sql`${invSlottingRecommendations.status} = 'PENDING'`,
          this.recommendationInScope(scope),
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
   * Is `locationId` the zone itself or one of its descendants?
   *
   * The same recursive walk `slotFor` uses to expand a rule's zone into bins,
   * with the same depth bound — a second, subtly different definition of
   * "inside the zone" is how an approval and the rule that proposed it start
   * disagreeing.
   */
  private async isUnderZone(
    orgId: string,
    zoneLocationId: number,
    locationId: number,
  ): Promise<boolean> {
    if (zoneLocationId === locationId) return true;
    const rows = await this.db.execute<{ id: number }>(sql`
      WITH RECURSIVE zone AS (
        SELECT id, parent_location_id, 1 AS depth
        FROM inv_locations
        WHERE org_id = ${orgId} AND id = ${zoneLocationId}
        UNION ALL
        SELECT l.id, l.parent_location_id, zone.depth + 1
        FROM inv_locations l
        JOIN zone ON l.parent_location_id = zone.id
        WHERE l.org_id = ${orgId} AND zone.depth < 16
      )
      SELECT id FROM zone WHERE id = ${locationId} LIMIT 1
    `);
    return rows.length > 0;
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
    /*
     * Scoped like `list` is. The row was fetched on `org_id` and its id alone,
     * so a supervisor holding no part of a building could approve a re-slot
     * inside it — and approving is a decision that ends with stock moving.
     * Out of scope reads as not found, the same answer a missing row gives.
     */
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty) throw new NotFoundException("Not found");
    const [row] = await this.db
      .select()
      .from(invSlottingRecommendations)
      .where(
        and(
          eq(invSlottingRecommendations.orgId, orgId),
          eq(invSlottingRecommendations.id, recommendationId),
          this.recommendationInScope(scope),
        ),
      );
    if (!row) throw new NotFoundException("Not found");
    if (row.status !== "PENDING") {
      throw new BadRequestException(`This recommendation is already ${row.status.toLowerCase()}`);
    }

    await this.warehouseScope.assertLocationVisible(orgId, userId, toLocationId);

    /*
     * And the bin has to be inside the zone this recommendation is FOR.
     *
     * `assertLocationVisible` answers "may this person see that location", which
     * is a different question and was the only one being asked — so an approver
     * could accept "move these 400 units to the gold zone" and name a bin in
     * cold storage, and the recommendation would record itself as approved with
     * the reason still saying gold. The rule the recommendation came from
     * expands its zone to descendant bins (`slotFor`); this walks the same tree
     * from the zone the recommendation stored, so the two cannot disagree about
     * what "inside the zone" means.
     */
    if (!(await this.isUnderZone(orgId, row.toZoneLocationId, toLocationId))) {
      throw new BadRequestException(
        "That bin is not inside the zone this recommendation points at. Dismiss it and raise an ordinary transfer if the stock should go somewhere else.",
      );
    }

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
