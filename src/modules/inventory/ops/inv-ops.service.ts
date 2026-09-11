import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invLocations, invStockLevels, invWarehouses } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { availableQtySql } from "../stock-engine/available-sql";
import { InvProjectsService } from "../projects/inv-projects.service";
import {
  attentionBoard,
  type AttentionBoardDeps,
  type AttentionItem,
} from "./lib/attention-board";

/**
 * B2 — one row of the Needs Attention board. Declared in `lib/attention-board.ts`
 * beside the only code that builds one, and re-exported here because the
 * controller and the AI briefing both name the service, not the lib.
 */
export type { AttentionItem };

const ZERO = "0";

@Injectable()
export class InvOpsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly settings: InventorySettingsService,
    private readonly projects: InvProjectsService,
  ) {}

  /**
   * The board reads through the same collaborators this service is injected
   * with; nothing about its DI graph changes by living next door.
   */
  private get attentionDeps(): AttentionBoardDeps {
    return {
      db: this.db,
      warehouseScope: this.warehouseScope,
      settings: this.settings,
      projects: this.projects,
    };
  }

  /**
   * B2 — the dark-store board: what each facility is holding and what it owes.
   *
   * One grouped query rather than one per store. Availability comes from the
   * canonical expression, never a hand-written subtraction — six copies of that
   * formula existed once and none of them subtracted `outgoing_qty`.
   */
  async zoneBoard(orgId: string, userId: string) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const scopeKey = scope === null ? "all" : ([...scope].sort((a, b) => a - b).join(".") || "none");
    return this.cache.cachedVersionedForOrg(
      orgId,
      "inv:ops:zones",
      scopeKey,
      async () => {
        const rows = await this.db
          .select({
            warehouseId: invWarehouses.id,
            name: invWarehouses.name,
            code: invWarehouses.code,
            facilityType: invWarehouses.facilityType,
            zone: invWarehouses.zone,
            zoneLabel: invWarehouses.zoneLabel,
            city: invWarehouses.city,
            deliveryPromiseMinutes: invWarehouses.deliveryPromiseMinutes,
            isActive: invWarehouses.isActive,
            skuCount: sql<number>`count(distinct ${invStockLevels.productVariantId})::int`,
            onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
            reserved: sql<string>`COALESCE(SUM(${invStockLevels.committed}::numeric), 0)::text`,
            damaged: sql<string>`COALESCE(SUM(COALESCE(${invStockLevels.blockedQty}, 0)::numeric), 0)::text`,
            quarantined: sql<string>`COALESCE(SUM(COALESCE(${invStockLevels.qualityHoldQty}, 0)::numeric), 0)::text`,
            picked: sql<string>`COALESCE(SUM(COALESCE(${invStockLevels.outgoingQty}, 0)::numeric), 0)::text`,
            // Goods in a van between two stores: on hand org-wide, pickable
            // nowhere. `is_sellable = false` on the TRANSIT location is what
            // keeps them out of `available` above; this reports them so an
            // operator can see the difference rather than infer it.
            inTransit: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric) FILTER (WHERE ${invLocations.locationType} = 'TRANSIT'), 0)::text`,
            available: sql<string>`COALESCE(SUM(${availableQtySql("inv_stock_levels")}), 0)::text`,
            stockValue: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric * COALESCE(${invStockLevels.averageCost}, 0)::numeric), 0)::text`,
            outOfStockSkus: sql<number>`count(distinct ${invStockLevels.productVariantId}) FILTER (WHERE ${invStockLevels.onHand}::numeric <= 0)::int`,
          })
          .from(invWarehouses)
          .leftJoin(
            invLocations,
            and(eq(invLocations.warehouseId, invWarehouses.id), eq(invLocations.orgId, invWarehouses.orgId)),
          )
          .leftJoin(
            invStockLevels,
            and(eq(invStockLevels.locationId, invLocations.id), eq(invStockLevels.orgId, invWarehouses.orgId)),
          )
          .where(
            and(
              eq(invWarehouses.orgId, orgId),
              this.warehouseScope.warehousePredicate(scope, sql`${invWarehouses.id}`),
            ),
          )
          .groupBy(invWarehouses.id)
          .orderBy(sql`${invWarehouses.zone} ASC NULLS LAST`, invWarehouses.name);
        return rows;
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * B2 — the Needs Attention board.
   *
   * @see lib/attention-board.ts — every probe, and the rule that a failed one
   * loses its own card rather than blanking the board.
   */
  async attention(orgId: string, userId: string): Promise<{ items: AttentionItem[]; generatedAt: string }> {
    return attentionBoard(this.attentionDeps, orgId, userId);
  }

  /**
   * B2 — the headline figures, each one a link to the list behind it.
   *
   * Separate from the Needs Attention board on purpose: these are the numbers a
   * manager reads every morning whether or not anything is wrong, and mixing
   * them with exceptions makes both harder to scan.
   */
  async summary(orgId: string, userId: string) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const stockScope = this.warehouseScope.locationPredicate(scope, sql`${invStockLevels.locationId}`);
    const scopeKey = scope === null ? "all" : ([...scope].sort((a, b) => a - b).join(".") || "none");

    return this.cache.cachedVersionedForOrg(
      orgId,
      "inv:ops:summary",
      scopeKey,
      async () => {
        const [buckets, facilities] = await Promise.all([
          this.db
            .select({
              skuCount: sql<number>`count(distinct ${invStockLevels.productVariantId})::int`,
              onHand: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric), 0)::text`,
              reserved: sql<string>`COALESCE(SUM(${invStockLevels.committed}::numeric), 0)::text`,
              damaged: sql<string>`COALESCE(SUM(COALESCE(${invStockLevels.blockedQty}, 0)::numeric), 0)::text`,
              quarantined: sql<string>`COALESCE(SUM(COALESCE(${invStockLevels.qualityHoldQty}, 0)::numeric), 0)::text`,
              picked: sql<string>`COALESCE(SUM(COALESCE(${invStockLevels.outgoingQty}, 0)::numeric), 0)::text`,
              onOrder: sql<string>`COALESCE(SUM(${invStockLevels.onOrder}::numeric), 0)::text`,
              // In transit is stock parked at a TRANSIT location — goods in a
              // van between two dark stores. Deliberately not `on_order`, which
              // is what a supplier still owes us and has not shipped: conflating
              // the two tells an operator to expect goods today that are not
              // even packed.
              inTransit: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM inv_locations transit_loc
                  WHERE transit_loc.id = ${invStockLevels.locationId}
                    AND transit_loc.location_type = 'TRANSIT'
                )
              ), 0)::text`,
              available: sql<string>`COALESCE(SUM(${availableQtySql("inv_stock_levels")}), 0)::text`,
              // Value is a decimal all the way through Postgres and is handed
              // over as text. A float here is a rounding error in a figure
              // somebody reconciles against their accounts.
              stockValue: sql<string>`COALESCE(SUM(${invStockLevels.onHand}::numeric * COALESCE(${invStockLevels.averageCost}, 0)::numeric), 0)::text`,
            })
            .from(invStockLevels)
            .where(and(eq(invStockLevels.orgId, orgId), stockScope)),
          this.db
            .select({
              total: sql<number>`count(*)::int`,
              darkStores: sql<number>`count(*) FILTER (WHERE ${invWarehouses.facilityType} = 'DARK_STORE')::int`,
              zones: sql<number>`count(distinct ${invWarehouses.zone})::int`,
            })
            .from(invWarehouses)
            .where(
              and(
                eq(invWarehouses.orgId, orgId),
                eq(invWarehouses.isActive, true),
                this.warehouseScope.warehousePredicate(scope, sql`${invWarehouses.id}`),
              ),
            ),
        ]);

        const b = buckets[0];
        return {
          quantities: {
            onHand: b?.onHand ?? ZERO,
            available: b?.available ?? ZERO,
            reserved: b?.reserved ?? ZERO,
            damaged: b?.damaged ?? ZERO,
            quarantined: b?.quarantined ?? ZERO,
            picked: b?.picked ?? ZERO,
            inTransit: b?.inTransit ?? ZERO,
            onOrder: b?.onOrder ?? ZERO,
          },
          skuCount: b?.skuCount ?? 0,
          stockValue: b?.stockValue ?? ZERO,
          facilities: {
            total: facilities[0]?.total ?? 0,
            darkStores: facilities[0]?.darkStores ?? 0,
            zones: facilities[0]?.zones ?? 0,
          },
        };
      },
      CACHE_TTL.SHORT,
    );
  }
}
