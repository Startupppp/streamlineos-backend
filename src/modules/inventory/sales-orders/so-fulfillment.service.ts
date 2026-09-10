import { Inject, Injectable, BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invSalesOrders, invStockReservations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { ChannelPoolService } from "../stock-engine/channel-pool.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import { SoCoreService } from "./so-core.service";
import { clientBehindSource, resolveShelfLifeFloor } from "../settings/min-shelf-life";
import type { ReserveSoInput, PickSoInput, PackSoInput, ShipSoInput } from "./dto/inv-sales-orders.schemas";
import { addDec } from "../stock-engine/decimal";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { runIdempotent } from "../stock-engine/idempotency";
import {
  type DeferredCogs,
  type ShipSoResult,
  postShipment,
  reviveShipResult,
} from "./so-ship";
import { IndiaComplianceService } from "../compliance/india-compliance.service";
import { pickSo, type FulfilmentDeps } from "./lib/so-pick-pack";
import { packSo } from "./lib/so-pack";
import {
  fileStatutoryDocuments,
  type FilingDeps,
} from "./lib/statutory-filing";

/** The pick result as it comes back from the idempotency row's stored JSON. */

@Injectable()
export class SoFulfillmentService {
  private readonly logger = new Logger(SoFulfillmentService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly reservationService: ReservationService,
    private readonly channelPools: ChannelPoolService,
    private readonly settingsService: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
    private readonly journalPosting: InventoryAccountingBridge,
    private readonly soCore: SoCoreService,
    private readonly projection: StockProjectionService,
    private readonly compliance: IndiaComplianceService,
  ) {}

  async reserveSo(orgId: string, soId: number, userId: string, idempotencyKey: string, data: ReserveSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "CONFIRMED" && so.status !== "PARTIALLY_RESERVED") {
      throw new BadRequestException("Sales order must be CONFIRMED or PARTIALLY_RESERVED to reserve stock");
    }

    const settings = await this.settingsService.get(orgId);

    // D2. The same two constraints `autoReserve` applies, resolved once for the
    // order. Without them this path — the explicit "reserve stock" button on a
    // confirmed order — allocated with no near-expiry tier and no customer
    // shelf-life floor, so the button quietly took lots the automatic path had
    // refused minutes earlier.
    const clientId = await clientBehindSource(this.db, orgId, "inv_sales_order", String(soId));
    const floor = await resolveShelfLifeFloor(this.db, orgId, clientId);
    const constraints = {
      nearExpiryPolicy: settings.nearExpiryPolicy,
      nearExpiryWindowDays: settings.nearExpiryWindowDays,
      minShelfLifeDays: floor.days,
    };

    let allReserved = true;

    await this.db.transaction(async (tx) => {
      for (const line of so.lines) {
        const existingReservation = await (tx as Db).query.invStockReservations.findFirst({
          where: and(
            eq(invStockReservations.orgId, orgId),
            eq(invStockReservations.sourceType, "inv_sales_order"),
            eq(invStockReservations.sourceId, String(soId)),
            eq(invStockReservations.sourceLineId, String(line.id)),
            eq(invStockReservations.status, "ACTIVE"),
          ),
        });
        if (existingReservation) continue;

        if (settings.reservationStrategy === "MANUAL") {
          const allocation = data.allocations?.find((a) => a.soLineId === line.id);
          if (!allocation) { allReserved = false; continue; }

          try {
            await this.reservationService.createReservationInTx(tx, orgId, userId, {
              sourceType: "inv_sales_order",
              sourceId: String(soId),
              sourceLineId: String(line.id),
              productVariantId: line.productVariantId,
              locationId: allocation.locationId,
              lotId: allocation.lotId,
              serialId: allocation.serialId,
              qty: addDec(allocation.qty, "0"),
              channelId: so.channelId ?? null,
            });
          } catch (reserveErr) {
            allReserved = false;
            this.logger.warn(
              `reserveSo: manual reservation failed for SO ${soId} line ${line.id} in org ${orgId}: ${reserveErr instanceof Error ? reserveErr.message : String(reserveErr)}`,
            );
          }
        } else {
          const available = await this.soCore.findAvailableLotForLine(
            orgId, line.productVariantId, data.warehouseId ?? so.warehouseId ?? undefined,
            line.quantity, settings.reservationStrategy, settings.expiryReservationPolicy,
            constraints,
          );

          if (!available) { allReserved = false; continue; }

          try {
            await this.reservationService.createReservationInTx(tx, orgId, userId, {
              sourceType: "inv_sales_order",
              sourceId: String(soId),
              sourceLineId: String(line.id),
              productVariantId: line.productVariantId,
              warehouseId: data.warehouseId ?? so.warehouseId ?? undefined,
              locationId: available.locationId,
              lotId: available.lotId,
              handlingUnitId: available.handlingUnitId ?? null,
              qty: line.quantity,
              channelId: so.channelId ?? null,
            });
          } catch (reserveErr) {
            allReserved = false;
            this.logger.warn(
              `reserveSo: auto reservation failed for SO ${soId} line ${line.id} in org ${orgId}: ${reserveErr instanceof Error ? reserveErr.message : String(reserveErr)}`,
            );
          }
        }
      }

      const newStatus = allReserved ? "RESERVED" : "PARTIALLY_RESERVED";
      await (tx as Db).update(invSalesOrders)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
    });

    const newStatus = allReserved ? "RESERVED" : "PARTIALLY_RESERVED";

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return { soId, status: newStatus, allReserved };
  }

  private get fulfilmentDeps(): FulfilmentDeps {
    return {
      db: this.db,
      cache: this.cache,
      numSeq: this.numSeq,
      projection: this.projection,
      settingsService: this.settingsService,
    };
  }

  private get filingDeps(): FilingDeps {
    return { db: this.db, logger: this.logger, compliance: this.compliance };
  }

  /** @see lib/so-pick-pack.ts — the bodies moved, the route surface did not. */
  async pickSo(orgId: string, soId: number, userId: string, data: PickSoInput, idempotencyKey: string) {
    return pickSo(this.fulfilmentDeps, orgId, soId, userId, data, idempotencyKey);
  }

  /** @see lib/so-pick-pack.ts */
  async packSo(orgId: string, soId: number, userId: string, data: PackSoInput, idempotencyKey: string) {
    return packSo(this.fulfilmentDeps, orgId, soId, userId, data, idempotencyKey);
  }

  /**
   * B7 — the one command that moves stock out of the building.
   *
   * Three things were true of this method and are no longer:
   *
   *   **It was not idempotent.** The `Idempotency-Key` reached only
   *   `engine.executeInTx`, which claims it for the *ledger*. Everything else —
   *   the shipment row, its lines, `quantity_shipped`, the serial flips, both
   *   outbox events and the COGS journal — sat outside any claim, so a client
   *   retrying after a timeout on a ship that had already committed got a
   *   replayed (no-op) stock posting wrapped in a **second** shipment, a second
   *   dispatch event and a second set of shipped quantities. The whole command
   *   is claimed now, with the engine handed a derived `:stock` key so its own
   *   claim cannot collide with the command's.
   *
   *   **It was not atomic.** The order, the pick lines and the reservations were
   *   all read on `this.db` *before* the transaction opened. Two concurrent
   *   ships of one order therefore both read the same ACTIVE reservations and
   *   both handed them to `consumeReservationsBatch`, which calls
   *   `releaseCommitted` for every reservation it is *given* rather than every
   *   one it flipped — so `committed` was subtracted twice for the same units.
   *   Every read is inside the transaction now and the reservations are taken
   *   `FOR UPDATE`, which is the guard `PickCompletionService` already uses: the
   *   second ship blocks on the row, re-evaluates `status = 'ACTIVE'` after the
   *   lock, and finds nothing to consume.
   *
   *   **The status guard sat outside the claim** — `packSo`'s sibling bug, where
   *   a retry after a committed pack was refused on the status its own first run
   *   had set. It is inside the claim, so a replay answers before it is reached.
   */
  async shipSo(
    orgId: string,
    soId: number,
    userId: string,
    idempotencyKey: string,
    data: ShipSoInput,
  ): Promise<ShipSoResult> {
    const settings = await this.settingsService.get(orgId);
    const cogs: DeferredCogs = { total: "0", soNumber: "" };

    const result = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.ship", soId, data },
        () =>
          postShipment(
            {
              engine: this.engine,
              reservations: this.reservationService,
              numSeq: this.numSeq,
              projection: this.projection,
              channelPools: this.channelPools,
            },
            tx,
            { orgId, soId, userId, idempotencyKey, data, settings, cogs },
          ),
        (stored) => reviveShipResult(stored),
      ),
    );

    await this.engine.invalidateCaches(orgId);

    // Only reachable when `work()` ran, so a replay posts nothing; and after the
    // commit, so a rolled-back shipment leaves no entry behind.
    const cogsTotal = Number(cogs.total);
    if (cogsTotal > 0) {
      // INV-09 — through the bridge, not `JournalPostingService` directly.
      //
      // This call site was one of two that reached past the bridge, and both
      // consequences were real. `persistJournalEntry` raises "Seed COA first"
      // when the tenant has no account 5000, and it raises `42P01` when
      // `journal_entries` is absent from the database entirely — which is the
      // whole reason the bridge exists. Both throws land *after* `runIdempotent`
      // has committed, so the shipment is already durable and the operator gets
      // a 500 for a dispatch that happened, then retries into the same throw.
      // The bridge warns and skips instead, which is what every docblock in this
      // module already says shipping does, and what `gl-recon`'s MISSING_COA
      // status already assumes.
      await this.journalPosting.postJournalEntry({
        orgId,
        entryDate: data.shipDate,
        description: `COGS: ${cogs.soNumber}`,
        sourceType: "inv_sales_order",
        sourceId: soId.toString(),
        sourceEvent: "ship",
        status: "POSTED",
        createdBy: userId,
        lines: [
          { purpose: "INVENTORY_COGS", debit: cogsTotal, credit: 0, description: `COGS - SO ${cogs.soNumber}` },
          { purpose: "INVENTORY_ASSET", debit: 0, credit: cogsTotal, description: `Inventory deducted - ${cogs.soNumber}` },
        ],
      });
    }

    // E5 — the statutory documents this dispatch owes, if this organisation has
    // asked for any.
    //
    // **After** the transaction, deliberately and for two reasons. The ship
    // transaction's last write must stay the `outgoing_qty` recompute — a write
    // slipped in after it silently corrupts the projection — and this does I/O
    // to a provider, which must never happen while a pooled connection is held
    // with a tenant GUC on it (§4).
    await fileStatutoryDocuments(this.filingDeps, orgId, userId, soId, result, settings);

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));

    return result;
  }

}
