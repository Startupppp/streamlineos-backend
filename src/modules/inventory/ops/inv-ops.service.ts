import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  invLocations,
  invProducts,
  invProductVariants,
  invPurchaseOrders,
  invStockLevels,
  invStockReservations,
  invStockTransfers,
  invWarehouses,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { availableQtySql } from "../stock-engine/available-sql";
import { InvProjectsService } from "../projects/inv-projects.service";

/**
 * B2 — one row of the Needs Attention board.
 *
 * Every card carries its own deep link, because a number a person cannot act on
 * is decoration. `href` is a route, not a page of results: the board's job is to
 * get somebody to the filtered list where the work is, and nothing more.
 */
export interface AttentionItem {
  /** Stable key, so the client can animate the list without reordering surprises. */
  key: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  count: number;
  href: string;
  /** The verb the operator would use next. Null when the link is the whole action. */
  actionLabel: string | null;
}

const ZERO = "0";

/** How long a transfer may sit dispatched before it is treated as late. */
const TRANSIT_STALE_HOURS = 24;
/** How close a reservation's expiry has to be before it is worth surfacing. */
const RESERVATION_EXPIRY_WARNING_HOURS = 48;

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
   * Every entry is something somebody has to decide about today. Counts only,
   * with a link to the list that holds the detail: a dashboard that tries to
   * carry the rows as well is a dashboard that loads slowly and is read rarely.
   *
   * `Promise.allSettled` rather than `all`: one slow or failing probe must
   * degrade its own card, not blank the board. A rejected probe is dropped from
   * the list — showing "0 stockouts" because the query failed would be worse
   * than showing nothing.
   */
  async attention(orgId: string, userId: string): Promise<{ items: AttentionItem[]; generatedAt: string }> {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const stockScope = this.warehouseScope.locationPredicate(scope, sql`${invStockLevels.locationId}`);
    const packs = await this.settings.get(orgId).then((s) => s.packs);

    const transitCutoff = new Date(Date.now() - TRANSIT_STALE_HOURS * 60 * 60 * 1000);
    const expiryCutoff = new Date(Date.now() + RESERVATION_EXPIRY_WARNING_HOURS * 60 * 60 * 1000);

    const countOf = (rows: { count: number }[]) => rows[0]?.count ?? 0;

    const probes = await Promise.allSettled([
      // Out of stock: on hand at or below zero on a SKU somebody still sells.
      this.db
        .select({ count: sql<number>`count(distinct ${invStockLevels.productVariantId})::int` })
        .from(invStockLevels)
        .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
        .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
        .where(
          and(
            eq(invStockLevels.orgId, orgId),
            stockScope,
            eq(invProducts.status, "ACTIVE"),
            sql`${invStockLevels.onHand}::numeric <= 0`,
          ),
        )
        .then(countOf),

      // Low stock: at or below the reorder point but not yet out. Two facts, two
      // cards — "order more this week" and "somebody is already being told no"
      // are different jobs.
      this.db
        .select({ count: sql<number>`count(distinct ${invStockLevels.productVariantId})::int` })
        .from(invStockLevels)
        .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
        .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
        .where(
          and(
            eq(invStockLevels.orgId, orgId),
            stockScope,
            eq(invProducts.status, "ACTIVE"),
            sql`${invStockLevels.onHand}::numeric > 0`,
            sql`${invStockLevels.onHand}::numeric <= ${invProducts.reorderPoint}::numeric`,
          ),
        )
        .then(countOf),

      // Damaged / blocked stock standing in a bin.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockLevels)
        .where(
          and(
            eq(invStockLevels.orgId, orgId),
            stockScope,
            sql`COALESCE(${invStockLevels.blockedQty}, 0)::numeric > 0`,
          ),
        )
        .then(countOf),

      // Quarantined stock awaiting a quality decision.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockLevels)
        .where(
          and(
            eq(invStockLevels.orgId, orgId),
            stockScope,
            sql`COALESCE(${invStockLevels.qualityHoldQty}, 0)::numeric > 0`,
          ),
        )
        .then(countOf),

      // Transfers dispatched and not received. Stock in a van is stock nobody
      // can pick, and a van nobody has closed off is stock nobody can find.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockTransfers)
        .where(
          and(
            eq(invStockTransfers.orgId, orgId),
            // A transfer stays IN_TRANSIT through a partial receipt — the
            // remainder is still in the van — so this one status covers both.
            eq(invStockTransfers.status, "IN_TRANSIT"),
            isNotNull(invStockTransfers.dispatchedAt),
            lt(invStockTransfers.dispatchedAt, transitCutoff),
          ),
        )
        .then(countOf),

      // Purchase orders sent or partly received and still open.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invPurchaseOrders)
        .where(
          and(
            eq(invPurchaseOrders.orgId, orgId),
            inArray(invPurchaseOrders.status, ["SENT", "PARTIAL"]),
          ),
        )
        .then(countOf),

      // Reservations about to lapse. Stock held for an order that has not moved
      // is stock nobody can sell and nobody is using.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockReservations)
        .where(
          and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.status, "ACTIVE"),
            isNotNull(invStockReservations.expiresAt),
            lte(invStockReservations.expiresAt, expiryCutoff),
          ),
        )
        .then(countOf),

      // Reservations already past their expiry that nothing has swept.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockReservations)
        .where(
          and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.status, "ACTIVE"),
            isNotNull(invStockReservations.expiresAt),
            lt(invStockReservations.expiresAt, new Date()),
          ),
        )
        .then(countOf),

      // Negative on-hand: a real mismatch between the ledger and the shelf.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockLevels)
        .where(and(eq(invStockLevels.orgId, orgId), stockScope, sql`${invStockLevels.onHand}::numeric < 0`))
        .then(countOf),

      // Committed beyond on hand: promised more than exists at that bin.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(invStockLevels)
        .where(
          and(
            eq(invStockLevels.orgId, orgId),
            stockScope,
            sql`${invStockLevels.committed}::numeric > ${invStockLevels.onHand}::numeric`,
          ),
        )
        .then(countOf),

      // B1. Site requirements heading for a miss. Only asked while the pack is
      // on — the service 404s otherwise, and a 404 inside a dashboard probe is
      // noise rather than information.
      packs.materials ? this.projects.atRiskRequirements(orgId, 100).then((r) => r.length) : Promise.resolve(0),
    ]);

    const value = (index: number): number => {
      const probe = probes[index];
      return probe && probe.status === "fulfilled" ? (probe.value as number) : -1;
    };

    const candidates: (AttentionItem | null)[] = [
      this.card(value(0), {
        key: "out-of-stock",
        severity: "critical",
        title: "Out of stock",
        detail: "Active SKUs with nothing on hand. Orders for these are being refused now.",
        href: "/inventory/stock?stockStatus=out",
        actionLabel: "Create Purchase Order",
      }),
      this.card(value(10), {
        key: "projects-at-risk",
        severity: "critical",
        title: "Site requirements at risk",
        detail: "Material a site is waiting for that is short, with the date inside the lead time.",
        href: "/inventory/projects?risk=at-risk",
        actionLabel: "Reserve Stock",
      }),
      this.card(value(8), {
        key: "negative-stock",
        severity: "critical",
        title: "Negative on-hand",
        detail: "The ledger says less than nothing is on the shelf. Count it before anything else.",
        href: "/inventory/reconciliation",
        actionLabel: "Start Cycle Count",
      }),
      this.card(value(9), {
        key: "over-committed",
        severity: "critical",
        title: "Promised more than we hold",
        detail: "Reserved quantity exceeds on-hand at a bin — one of these promises will be broken.",
        href: "/inventory/reconciliation",
        actionLabel: "View Discrepancies",
      }),
      this.card(value(7), {
        key: "reservations-expired",
        severity: "warning",
        title: "Reservations already expired",
        detail: "Holds past their expiry that nothing has released. This stock is unsellable and unused.",
        href: "/inventory/stock?tab=reservations&state=expired",
        actionLabel: "Release Reservation",
      }),
      this.card(value(1), {
        key: "low-stock",
        severity: "warning",
        title: "Low stock",
        detail: "At or below the reorder point. Buying has to start before these run out.",
        href: "/inventory/replenishment",
        actionLabel: "Review Reorder Suggestions",
      }),
      this.card(value(4), {
        key: "transfers-delayed",
        severity: "warning",
        title: "Transfers still in transit",
        detail: `Dispatched more than ${TRANSIT_STALE_HOURS} hours ago and not received. The stock is in a van, not on a shelf.`,
        href: "/inventory/stock?tab=transfers&status=IN_TRANSIT",
        actionLabel: "Receive Transfer",
      }),
      this.card(value(5), {
        key: "purchase-orders-open",
        severity: "warning",
        title: "Purchase orders not fully received",
        detail: "Sent or part-received orders still waiting on goods.",
        href: "/inventory/purchase-orders?status=SENT",
        actionLabel: "Receive Stock",
      }),
      this.card(value(2), {
        key: "damaged-stock",
        severity: "warning",
        title: "Damaged stock in bins",
        detail: "Blocked quantity sitting in pickable locations. It needs writing off or returning.",
        href: "/inventory/stock?bucket=damaged",
        actionLabel: "Adjust Quantity",
      }),
      this.card(value(3), {
        key: "quarantined-stock",
        severity: "info",
        title: "Quarantined stock",
        detail: "Held pending a quality decision. Nothing can be promised from it until somebody rules.",
        href: "/inventory/quality",
        actionLabel: "Review Inspection",
      }),
      this.card(value(6), {
        key: "reservations-expiring",
        severity: "info",
        title: "Reservations expiring soon",
        detail: `Holds lapsing within ${RESERVATION_EXPIRY_WARNING_HOURS} hours. Confirm or extend them.`,
        href: "/inventory/stock?tab=reservations&state=expiring",
        actionLabel: null,
      }),
    ];

    const order = { critical: 0, warning: 1, info: 2 } as const;
    const items = candidates
      .filter((c): c is AttentionItem => c !== null)
      .sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

    return { items, generatedAt: new Date().toISOString() };
  }

  /**
   * A card is shown only when the count is genuinely above zero.
   *
   * `-1` means the probe failed. It is dropped rather than rendered as zero: a
   * board that quietly reports "no stockouts" because a query timed out is worse
   * than one that is a card short, because only the second is noticeable.
   */
  private card(count: number, card: Omit<AttentionItem, "count">): AttentionItem | null {
    if (count <= 0) return null;
    return { ...card, count };
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
