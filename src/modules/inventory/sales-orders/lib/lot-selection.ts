import { and, eq } from "drizzle-orm";
import { invLots, invStockLevels } from "../../../../db/schema";
import { availableQty, cmpDec } from "../../stock-engine/decimal";
import { verdictFor, type EligibilityPolicy, type LotFacts } from "../lot-eligibility";
import type { Db } from "../../../../db/drizzle.module";

/**
 * Choosing the stock row that can satisfy a sales-order line, lifted out of
 * `so-lifecycle.service.ts` unchanged — 148 lines, a quarter of that file, using
 * only the db handle.
 *
 * It stays public API through a delegate: three picking services reach it as
 * `this.soCore.findAvailableLotForLine(...)`, i.e. through `SoCoreService`, which
 * itself delegates here.
 */
  /**
   * Picks a stock row that can satisfy a line — INV-402.
   *
   * Lot eligibility used to live inside `if (strategy === "FEFO")`, so with any
   * other strategy control fell straight through to `filtered[0]` and returned
   * the first row it found. The default strategy is AUTO_ON_CONFIRM, which means
   * expired, blocked and recalled lots were allocatable and shippable in the
   * default configuration whatever `expiryReservationPolicy` said. The PRD calls
   * for a hard block on expired, recalled and quarantined stock; there was none.
   *
   * Eligibility is now a filter over every candidate, and the strategy only
   * decides the order of what is already eligible. Those are different
   * questions, and collapsing them is what let the block be skipped.
   */
export async function findAvailableLotForLine(
    db: Db,
    orgId: string,
    variantId: number,
    warehouseId: number | null | undefined,
    qty: string,
    strategy: string,
    expiryPolicy: string,
    /**
     * D2. The two constraints that are not about the lot alone.
     *
     * Optional so every existing caller keeps its behaviour — omitted, near
     * expiry reads as `ALLOW` and the shelf-life floor as none, which is exactly
     * what those callers did before. `minShelfLifeDays` is the destination's
     * contracted floor and belongs to the *customer*, so only a caller that
     * knows which customer it is allocating for can supply it.
     */
    constraints?: {
      nearExpiryPolicy: EligibilityPolicy["nearExpiryPolicy"];
      nearExpiryWindowDays: number;
      minShelfLifeDays: number;
    },
  ): Promise<{ locationId: number; lotId?: number; handlingUnitId?: number } | null> {
    const levels = await db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        eq(invStockLevels.productVariantId, variantId),
      ),
      with: {
        location: { columns: { id: true, warehouseId: true, isSellable: true } },
      },
      columns: {
        id: true,
        locationId: true,
        lotId: true,
        serialId: true,
        // NEO-4. The allocator picks a *stock row*, and since handling units
        // joined the natural key a row is a pallet as well as a bin. Returning
        // only the location made the reservation that follows look up a loose row
        // that does not exist — the pallet's hundred units were invisible to it,
        // and the promise was refused with the stock standing in front of it.
        handlingUnitId: true,
        // NEO-11. Same reason, the other new dimension: consigned stock is on
        // hand and is not ours, and `availableQty` already returns zero for it —
        // but the row has to be told apart from the owned one to be excluded.
        ownership: true,
        onHand: true,
        committed: true,
        blockedQty: true,
        qualityHoldQty: true,
        outgoingQty: true,
      },
    });

    const lots = await db.query.invLots.findMany({
      where: and(eq(invLots.orgId, orgId), eq(invLots.productVariantId, variantId)),
      columns: { id: true, expiryDate: true, status: true },
    });
    const lotById: ReadonlyMap<number, LotFacts> = new Map(lots.map((lot) => [lot.id, lot]));

    // D2. Eligibility is now three answers, not two: eligible, deprioritized and
    // refused. `lot-eligibility.ts` owns the rules so the reserve path and the
    // override path cannot drift into two opinions about the same lot.
    const policy: EligibilityPolicy = {
      expiryPolicy,
      nearExpiryPolicy: constraints?.nearExpiryPolicy ?? "ALLOW",
      nearExpiryWindowDays: constraints?.nearExpiryWindowDays ?? 0,
      minShelfLifeDays: constraints?.minShelfLifeDays ?? 0,
    };

    const candidates = levels.filter((level) => {
      if (warehouseId && level.location?.warehouseId !== warehouseId) return false;
      if (verdictFor(level.lotId, lotById, policy).kind === "REFUSED") return false;
      // A2/A5. The one availability formula, not a private copy of it.
      //
      // This carried a four-term copy that omitted `outgoing_qty` and knew
      // nothing of `is_sellable`, so the allocator promised two kinds of stock
      // it must never promise: units already picked and standing on the packing
      // bench, and units parked at a warehouse's TRANSIT location while they sat
      // on a lorry. Reserving transit stock was the worse of the two — the
      // transfer's completion later issues those units out of transit, `on_hand`
      // reaches zero while `committed` stays behind, and availability at that
      // grain is negative from then on. Reconciliation reports no drift, because
      // the reservation really is ACTIVE.
      const available = availableQty({
        on_hand: level.onHand,
        committed: level.committed,
        blocked_qty: level.blockedQty,
        quality_hold_qty: level.qualityHoldQty,
        outgoing_qty: level.outgoingQty,
        is_sellable: level.location?.isSellable ?? null,
        ownership: level.ownership,
      });
      return cmpDec(available, qty) >= 0;
    });

    if (candidates.length === 0) return null;

    /**
     * The strategy orders what is already eligible; it never widens it.
     *
     * D2 adds a tier above the strategy: a short-dated lot sorts after every lot
     * that is not short-dated, whatever the strategy says. FEFO wants the
     * soonest-expiring first and near-expiry policy wants it last, and both get
     * what they asked for — near-expiry decides the tier, FEFO the order inside it.
     */
    const tier = (lotId: number | null): number =>
      verdictFor(lotId, lotById, policy).kind === "DEPRIORITIZED" ? 1 : 0;

    const ordered = [...candidates].sort((a, b) => {
      const tierDelta = tier(a.lotId) - tier(b.lotId);
      if (tierDelta !== 0) return tierDelta;
      if (strategy === "FEFO") {
        const aExpiry = a.lotId === null ? null : (lotById.get(a.lotId)?.expiryDate ?? null);
        const bExpiry = b.lotId === null ? null : (lotById.get(b.lotId)?.expiryDate ?? null);
        // A lot with no expiry date cannot expire first, so it sorts last —
        // NULLS LAST, the same answer Postgres gives an ascending order by.
        if (aExpiry !== bExpiry) {
          if (aExpiry === null) return 1;
          if (bExpiry === null) return -1;
          return aExpiry < bExpiry ? -1 : 1;
        }
      }
      if (strategy === "FIFO" || strategy === "FEFO") return (a.lotId ?? 0) - (b.lotId ?? 0);
      return 0;
    });

    const chosen = ordered[0];
    if (!chosen) return null;
    return {
      locationId: chosen.locationId,
      lotId: chosen.lotId ?? undefined,
      handlingUnitId: chosen.handlingUnitId ?? undefined,
    };
  }
