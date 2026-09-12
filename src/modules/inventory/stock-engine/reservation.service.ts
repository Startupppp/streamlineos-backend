import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { invStockReservations, invStockLevels } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { type Db } from "../../../db/drizzle.module";
import { InventorySettingsService } from "./inventory-settings.service";
import { ChannelPoolService } from "./channel-pool.service";
import { availableQty, cmpDec } from "./decimal";
import { INV_ERRORS, type ReservationInput } from "./stock-engine.types";
import { committedGrainPredicate } from "./lib/committed-grain";
import {
  consumeReservation,
  consumeReservationsBatch,
  expireStale,
  releaseReservationInTx,
  type ReleasedReservation,
  type ReservationUnwindDeps,
} from "./lib/reservation-unwind";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Re-exported so every existing importer is unchanged. Both declarations moved
 * into `lib/` rather than being imported back the other way, because
 * `check:cycles` counts a type-only import from `lib/` into the service as an
 * edge — and `committedGrainPredicate` in particular has to be reachable from
 * the unwind half without one.
 */
export { committedGrainPredicate } from "./lib/committed-grain";
export type { ReleasedReservation } from "./lib/reservation-unwind";

@Injectable()
export class ReservationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settingsService: InventorySettingsService,
    private readonly channelPools: ChannelPoolService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Every write to `inv_stock_reservations` has to bump the list namespace,
   * and this service was doing none of them.
   *
   * `InvStockReservationsService` caches the reservations list under
   * `inv:reservations:list:<org>` with `cachedVersioned` at a 30s TTL, and
   * invalidates it from its own two writers. But THIS service writes the same
   * table from five more places, and did not hold a CacheService at all -- so a
   * pick that consumed a hold left the endpoint answering ACTIVE for up to
   * thirty seconds after the row said CONSUMED. Measured: reservation 453 was
   * CONSUMED in the database at 15:28:00 and the endpoint still reported ACTIVE
   * half a minute later.
   *
   * Two services writing one table and only one of them invalidating is the
   * shape of the bug; putting it HERE, in the service that owns the write,
   * covers every caller -- picking, projects, substitution, GRN posting -- and
   * every future one, rather than asking each to remember.
   *
   * Deferred through `registerAfterCommit` because these methods are called
   * inside a caller's transaction as often as they open their own: the hooks
   * drain only on success, so a rolled-back release never bumps. With no
   * ambient context (a background sweep such as `expireStale`) there is nothing
   * to wait for, so it runs inline -- CLAUDE.md section 4 asks for exactly that
   * fallback rather than dropping the work.
   */
  private invalidateReservationList(orgId: string): void {
    const namespace = `inv:reservations:list:${orgId}`;
    const deferred = registerAfterCommit(() => this.cache.invalidateNamespace(namespace));
    if (!deferred) void this.cache.invalidateNamespace(namespace);
  }

  /**
   * The invalidation above, handed to `lib/reservation-unwind.ts` bound rather
   * than exported: the decision to defer it through `registerAfterCommit`
   * belongs to the class that holds the `CacheService`.
   */
  private get unwindDeps(): ReservationUnwindDeps {
    return {
      db: this.db,
      bumpReservationList: (orgId) => this.invalidateReservationList(orgId),
    };
  }

  async createReservation(orgId: string, userId: string, input: ReservationInput): Promise<typeof invStockReservations.$inferSelect> {
    return this.db.transaction(async (tx) => this.createReservationInTx(tx, orgId, userId, input));
  }

  async createReservationInTx(tx: Tx, orgId: string, userId: string, input: ReservationInput): Promise<typeof invStockReservations.$inferSelect> {
    const settings = await this.settingsService.get(orgId);

    // A reservation without a location cannot lock a stock row, cannot be checked
    // for availability and cannot decrement committed anywhere — it is a promise
    // with nothing behind it. Every internal caller already resolves a location.
    if (!input.locationId) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

    // NEO-11. `committedGrainPredicate` pins `ownership = 'OWNED'`, and that is
    // right: a promise is only ever made against our own stock. What was missing
    // is the refusal. `ReservationInput.ownership` is documented as existing "so
    // a caller cannot silently reserve the owned row when it meant the consigned
    // one" — and nothing read it, so a caller naming VENDOR was handed the OWNED
    // row and promised our units instead. On a shared pallet, where an owned and
    // a consigned grain differ in nothing but this column, that is the exact
    // collapse INV-18 exists to prevent, and it was invisible: the reservation
    // succeeded, the numbers added up, and the wrong row moved.
    if (input.ownership !== undefined && input.ownership !== "OWNED") {
      throw new BadRequestException({
        code: INV_ERRORS.INSUFFICIENT_STOCK,
        message: "Stock owned by somebody else cannot be reserved",
      });
    }

    await tx.insert(invStockLevels).values({
      orgId, productVariantId: input.productVariantId,
      locationId: input.locationId, lotId: input.lotId ?? null,
      serialId: input.serialId ?? null,
      handlingUnitId: input.handlingUnitId ?? null,
      onHand: "0", committed: "0", onOrder: "0",
      blockedQty: "0", qualityHoldQty: "0", outgoingQty: "0",
    }).onConflictDoNothing();

    // A2/A5. `is_sellable` is selected because `availableQty` gates on it, and
    // an absent field is not `false` — so omitting it made the transit gate dead
    // code on the one path that increments `committed`. This is the last line of
    // defence: whatever an allocator upstream decided, a reservation is the
    // moment stock is actually promised to somebody.
    const [level] = await tx.execute<{
      id: number; on_hand: string; committed: string; blocked_qty: string;
      quality_hold_qty: string; outgoing_qty: string; is_sellable: boolean | null;
      /**
       * Selected so `availableQty`'s consignment gate can fire here at all. It
       * treats `undefined` as "this caller has not been taught about
       * consignment" and falls through to the arithmetic — so omitting the
       * column did not merely skip a check, it made a consigned row compute as
       * if it were ours. The predicate above already excludes those rows; this
       * is the second line, because the file's own comment calls the
       * availability check the last one.
       */
      ownership: "OWNED" | "VENDOR" | "CUSTOMER" | null;
      warehouse_id: number;
    }>(sql`
      SELECT sl.id, sl.on_hand, sl.committed, sl.blocked_qty,
             sl.quality_hold_qty, sl.outgoing_qty, sl.ownership,
             loc.is_sellable, loc.warehouse_id
      FROM inv_stock_levels sl
      JOIN inv_locations loc
        ON loc.org_id = sl.org_id AND loc.id = sl.location_id
      WHERE ${committedGrainPredicate(orgId, {
        productVariantId: input.productVariantId,
        locationId: input.locationId,
        lotId: input.lotId ?? null,
        serialId: input.serialId ?? null,
        handlingUnitId: input.handlingUnitId ?? null,
      }, "sl")}
      FOR UPDATE OF sl
    `);

    if (!level) throw new BadRequestException({ code: INV_ERRORS.LOCATION_NOT_FOUND });

    // Refused whatever the backorder setting says. Allowing backorders means
    // "you may promise stock you do not have yet"; it does not mean "you may
    // promise stock that is on a lorry". Without this, an org with backorders on
    // skips the availability check entirely and reserves at a transit location
    // regardless — and the transfer's completion then issues those units away,
    // leaving `committed` behind and availability negative for good.
    if (level.is_sellable === false) {
      throw new BadRequestException({
        code: INV_ERRORS.INSUFFICIENT_STOCK,
        message: "Stock at this location is not sellable and cannot be reserved",
      });
    }

    const available = availableQty(level);

    if (!settings.allowBackorders && cmpDec(available, input.qty) < 0) {
      throw new BadRequestException({ code: INV_ERRORS.INSUFFICIENT_STOCK });
    }

    // NEO-1. The row check above asks whether the units are physically free where
    // they stand. This asks whether anybody else has already been promised them.
    // It is deliberately on this path and not on the allocator that chose the
    // location: a reservation is the moment stock is actually promised to
    // somebody, and every promise in the product passes through here.
    //
    // Unlike the row check, it holds whatever `allowBackorders` says. Backorders
    // mean "you may promise stock you have not received"; they have never meant
    // "you may promise the same unit to two customers", and a channel pool exists
    // precisely to stop the second.
    await this.channelPools.assertPromisable(tx, orgId, {
      productVariantId: input.productVariantId,
      warehouseId: input.warehouseId ?? Number(level.warehouse_id),
      qty: input.qty,
      forChannelId: input.channelId ?? null,
    });

    await tx.update(invStockLevels)
      .set({ committed: sql`committed + ${input.qty}::numeric` })
      .where(eq(invStockLevels.id, level.id));

    const [reservation] = await tx.insert(invStockReservations).values({
      orgId,
      sourceType: input.sourceType, sourceId: input.sourceId,
      sourceLineId: input.sourceLineId ?? null,
      productVariantId: input.productVariantId,
      warehouseId: input.warehouseId ?? null,
      locationId: input.locationId ?? null,
      lotId: input.lotId ?? null, serialId: input.serialId ?? null,
      handlingUnitId: input.handlingUnitId ?? null,
      reservedQty: input.qty, status: "ACTIVE",
      expiresAt: input.expiresAt ?? null,
    }).returning();

    this.invalidateReservationList(orgId);

    return reservation!;
  }

  /** @see lib/reservation-unwind.ts — the bodies moved, the service surface did not. */
  async releaseReservationInTx(
    tx: Tx, orgId: string, userId: string, reservationId: number,
  ): Promise<ReleasedReservation | null> {
    return releaseReservationInTx(this.unwindDeps, tx, orgId, userId, reservationId);
  }

  async consumeReservation(orgId: string, userId: string, reservationId: number): Promise<void> {
    return consumeReservation(this.unwindDeps, orgId, userId, reservationId);
  }

  async consumeReservationsBatch(
    tx: Tx,
    orgId: string,
    userId: string,
    reservations: ReadonlyArray<{
      id: number;
      locationId: number | null;
      productVariantId: number;
      lotId?: number | null;
      serialId?: number | null;
      handlingUnitId?: number | null;
      reservedQty: string;
    }>,
  ): Promise<number[]> {
    return consumeReservationsBatch(this.unwindDeps, tx, orgId, userId, reservations);
  }

  async expireStale(orgId: string): Promise<number> {
    return expireStale(this.unwindDeps, orgId);
  }
}
