import { and, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  invProducts,
  invProductVariants,
  invPurchaseOrders,
  invStockLevels,
  invStockReservations,
  invStockTransfers,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { InvProjectsService } from "../../projects/inv-projects.service";

/** How long a transfer may sit dispatched before it is treated as late. */
export const TRANSIT_STALE_HOURS = 24;
/** How close a reservation's expiry has to be before it is worth surfacing. */
export const RESERVATION_EXPIRY_WARNING_HOURS = 48;

/** What the probes read through. The service hands over its own injected collaborators. */
export interface AttentionProbeDeps {
  readonly db: Db;
  readonly warehouseScope: WarehouseScopeService;
  readonly settings: InventorySettingsService;
  readonly projects: InvProjectsService;
}

/**
 * One count per thing worth surfacing, and `-1` wherever the probe failed.
 *
 * `-1` rather than `0` or `null` is the entire contract between this file and
 * the board: a count of zero means "we looked and there is nothing", and a
 * failed probe means "we do not know". Collapsing the two is how a dashboard
 * comes to report no stockouts because a query timed out.
 */
export interface AttentionCounts {
  outOfStock: number;
  lowStock: number;
  damaged: number;
  quarantined: number;
  transfersDelayed: number;
  purchaseOrdersOpen: number;
  reservationsExpiring: number;
  reservationsExpired: number;
  negativeStock: number;
  overCommitted: number;
  projectsAtRisk: number;
}

/**
 * B2 — every count behind the Needs Attention board, asked in one breath.
 *
 * `Promise.allSettled` rather than `all`: one slow or failing probe must
 * degrade its own card, not blank the board. A rejected probe becomes `-1`
 * here and is dropped by the board — showing "0 stockouts" because the query
 * failed would be worse than showing nothing.
 */
export async function runAttentionProbes(
  deps: AttentionProbeDeps,
  orgId: string,
  userId: string,
): Promise<AttentionCounts> {
  const scope = await deps.warehouseScope.resolve(orgId, userId);
  const stockScope = deps.warehouseScope.locationPredicate(scope, sql`${invStockLevels.locationId}`);
  const packs = await deps.settings.get(orgId).then((s) => s.packs);

  const transitCutoff = new Date(Date.now() - TRANSIT_STALE_HOURS * 60 * 60 * 1000);
  const expiryCutoff = new Date(Date.now() + RESERVATION_EXPIRY_WARNING_HOURS * 60 * 60 * 1000);

  const countOf = (rows: { count: number }[]) => rows[0]?.count ?? 0;

  const probes = await Promise.allSettled([
    // Out of stock: on hand at or below zero on a SKU somebody still sells.
    deps.db
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
    deps.db
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
    deps.db
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
    deps.db
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
    deps.db
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
    deps.db
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
    deps.db
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
    deps.db
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
    deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invStockLevels)
      .where(and(eq(invStockLevels.orgId, orgId), stockScope, sql`${invStockLevels.onHand}::numeric < 0`))
      .then(countOf),

    // Committed beyond on hand: promised more than exists at that bin.
    deps.db
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
    packs.materials ? deps.projects.atRiskRequirements(orgId, 100).then((r) => r.length) : Promise.resolve(0),
  ]);

  const value = (index: number): number => {
    const probe = probes[index];
    return probe && probe.status === "fulfilled" ? (probe.value as number) : -1;
  };

  // Named rather than handed over as the positional array the probes settle
  // into. The board used to index this list by number across two hundred
  // lines, and once the two halves live in different files an off-by-one
  // there would put the stockout count on the quarantine card silently.
  return {
    outOfStock: value(0),
    lowStock: value(1),
    damaged: value(2),
    quarantined: value(3),
    transfersDelayed: value(4),
    purchaseOrdersOpen: value(5),
    reservationsExpiring: value(6),
    reservationsExpired: value(7),
    negativeStock: value(8),
    overCommitted: value(9),
    projectsAtRisk: value(10),
  };
}
