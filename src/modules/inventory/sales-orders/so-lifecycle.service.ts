import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  invLots,
  invSalesOrders,
  invStockLevels,
  invStockReservations,
  invoiceItems,
  invoices,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { subDec, cmpDec, availableQty } from "../stock-engine/decimal";
import { verdictFor, type EligibilityPolicy, type LotFacts } from "./lot-eligibility";
import { clientBehindSource, resolveShelfLifeFloor } from "../settings/min-shelf-life";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";

@Injectable()
export class SoLifecycleService {
  private readonly logger = new Logger(SoLifecycleService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly settingsService: InventorySettingsService,
    private readonly reservationService: ReservationService,
    private readonly projection: StockProjectionService,
    private readonly journalPosting: InventoryAccountingBridge,
    private readonly planLimits: PlanLimitsService,
  ) {}

  /**
   * A3. Confirming took no key. The DRAFT guard makes a repeat safe, but a
   * client retrying a timed-out confirm was told the order could not be
   * confirmed — when it already had been, and had auto-reserved stock on the
   * way. Replaying the original answer is what the key is for.
   */
  async confirmSo(orgId: string, soId: number, userId: string, idempotencyKey: string) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "DRAFT")
      throw new BadRequestException("Only DRAFT sales orders can be confirmed");

    const settings = await this.settingsService.get(orgId);

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.confirm", soId },
        async () => {
          await tx
            .update(invSalesOrders)
            .set({ status: "CONFIRMED", confirmedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
          return { confirmed: soId };
        },
        () => ({ confirmed: soId }),
      ),
    );

    if (settings.autoReserveOnConfirm) {
      try {
        await this.autoReserve(orgId, soId, userId, so.lines, so.warehouseId, so.channelId);
      } catch (error) {
        this.logger.warn(
          `Auto-reserve failed for sales order ${soId} in org ${orgId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
  }

  async cancelSo(orgId: string, soId: number, userId: string) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (
      so.status === "SHIPPED" ||
      so.status === "PARTIALLY_SHIPPED" ||
      so.status === "INVOICED"
    ) {
      throw new BadRequestException(
        "Cannot cancel a sales order that has been shipped or invoiced",
      );
    }
    if (so.status === "CANCELLED")
      throw new BadRequestException("Sales order is already cancelled");

    const reservations = await this.db.query.invStockReservations.findMany({
      where: and(
        eq(invStockReservations.orgId, orgId),
        eq(invStockReservations.sourceType, "inv_sales_order"),
        eq(invStockReservations.sourceId, String(soId)),
        eq(invStockReservations.status, "ACTIVE"),
      ),
      columns: { id: true },
    });

    // A1/A2. Anything already picked for this order is standing in a tote, and
    // cancelling the order is what sends it back to the shelf. Releasing the
    // reservations was the only unwind here, so picked-then-cancelled units
    // stayed in `outgoing_qty` for good — subtracted from availability by every
    // future query, with no document left alive to explain why. The
    // reconciliation report names it as `outgoing_vs_picks` drift.
    const picked = await this.db.execute<{
      product_variant_id: number;
      location_id: number;
      lot_id: number | null;
      serial_id: number | null;
      quantity: string;
    }>(sql`
      SELECT pll.product_variant_id, pll.location_id, pll.lot_id, pll.serial_id,
             pll.quantity_picked::text AS quantity
        FROM inv_pick_list_lines pll
        JOIN inv_so_lines sol ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
       WHERE pll.org_id = ${orgId}
         AND sol.so_id = ${soId}
         AND pll.location_id IS NOT NULL
         AND pll.quantity_picked::numeric > 0
      UNION ALL
      -- A substitute is what actually went in the tote, tracked on its own
      -- columns rather than folded into quantity_picked, so it needs its own
      -- release or the swapped-in units stay unsellable.
      SELECT pll.substitute_variant_id, pll.location_id, pll.lot_id, pll.serial_id,
             pll.substitute_quantity::text
        FROM inv_pick_list_lines pll
        JOIN inv_so_lines sol ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
       WHERE pll.org_id = ${orgId}
         AND sol.so_id = ${soId}
         AND pll.location_id IS NOT NULL
         AND pll.substitute_variant_id IS NOT NULL
         AND COALESCE(pll.substitute_quantity, 0)::numeric > 0
    `);

    await this.db.transaction(async (tx) => {
      for (const res of reservations) {
        await this.reservationService.releaseReservationInTx(
          tx,
          orgId,
          userId,
          res.id,
        );
      }

      // The status flip comes *before* the recompute, and the order is now
      // load-bearing. `outgoing_qty` is derived from the documents, and this
      // order is one of them: recomputing first re-reads a still-open order and
      // writes the same figure back, so the tote never empties. An increment did
      // not care about ordering, which is exactly the kind of assumption a
      // change of mechanism invalidates silently.
      await (tx as Db)
        .update(invSalesOrders)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
        );

      for (const row of picked) {
        await this.projection.syncOutgoing(tx, orgId, {
          productVariantId: row.product_variant_id,
          locationId: row.location_id,
          lotId: row.lot_id,
          serialId: row.serial_id,
        });
      }
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
  }

  async invoiceSo(orgId: string, soId: number, userId: string) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: {
        lines: {
          with: {
            productVariant: {
              with: { product: { columns: { id: true, name: true } } },
            },
          },
        },
      },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "SHIPPED" && so.status !== "PARTIALLY_SHIPPED") {
      throw new BadRequestException(
        "Only SHIPPED or PARTIALLY_SHIPPED sales orders can be invoiced",
      );
    }
    if (so.invoiceId)
      throw new ConflictException(
        "This sales order has already been invoiced",
      );

    await this.planLimits.assertWithinLimit(orgId, "acctInvoices");

    const invoiceNumber = await this.numSeq.next(orgId, "INVOICE");
    const lineItems = so.lines.map((l) => ({
      description: l.productVariant.product.name,
      quantity: parseFloat(l.quantity),
      rate: parseFloat(l.unitPrice),
      amount: parseFloat(l.amount),
    }));

    const today = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const [invoice] = await this.db
      .insert(invoices)
      .values({
        orgId,
        clientId: so.clientId,
        invoiceNumber,
        status: "ISSUED",
        subtotal: so.subtotal,
        taxRate: "0",
        taxAmount: so.taxAmount,
        discount: "0",
        total: so.total,
        currency: so.currency,
        dueDate,
        createdBy: userId,
      })
      .returning();

    if (lineItems.length > 0) {
      await this.db.insert(invoiceItems).values(
        lineItems.map((line, index) => ({
          invoiceId: invoice.id,
          description: line.description,
          quantity: line.quantity.toFixed(4),
          rate: line.rate.toFixed(4),
          gstRate: "0",
          amount: line.amount.toFixed(4),
          lineOrder: index,
        })),
      );
    }

    await this.db
      .update(invSalesOrders)
      .set({ status: "INVOICED", invoiceId: invoice.id, updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

    await this.journalPosting.postJournalEntry({
      orgId,
      entryDate: today,
      description: `Invoice: ${invoiceNumber}`,
      sourceType: "inv_sales_order",
      sourceId: soId.toString(),
      sourceEvent: "invoice",
      status: "POSTED",
      createdBy: userId,
      lines: [
        {
          accountCode: "1200",
          debit: Number(so.total),
          credit: 0,
          description: `AR - ${invoiceNumber}`,
        },
        {
          accountCode: "4000",
          debit: 0,
          credit: Number(so.total),
          description: `Sales Revenue - ${so.soNumber}`,
        },
      ],
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return invoice;
  }

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
  async findAvailableLotForLine(
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
  ): Promise<{ locationId: number; lotId?: number } | null> {
    const levels = await this.db.query.invStockLevels.findMany({
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
        onHand: true,
        committed: true,
        blockedQty: true,
        qualityHoldQty: true,
        outgoingQty: true,
      },
    });

    const lots = await this.db.query.invLots.findMany({
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
    return { locationId: chosen.locationId, lotId: chosen.lotId ?? undefined };
  }

  private async autoReserve(
    orgId: string,
    soId: number,
    userId: string,
    lines: Array<{ id: number; productVariantId: number; quantity: string }>,
    warehouseId: number | null | undefined,
    /**
     * NEO-1 — the channel this order came from, so it may draw on that channel's
     * own pool. Null for a direct sale, which may draw on none of them.
     */
    channelId: number | null | undefined,
  ) {
    const settings = await this.settingsService.get(orgId);

    // D2. The customer's contracted minimum shelf life, resolved once for the
    // whole order rather than per line — it is a term of one agreement, not a
    // property of a product. When it removes every candidate the order lands
    // PARTIALLY_RESERVED, which is the right answer: there is stock, and none of
    // it is stock this customer agreed to accept. Somebody holding
    // `inventory:allocation:override` then chooses a lot on purpose, with a
    // reason, and that choice is recorded.
    const clientId = await clientBehindSource(this.db, orgId, "inv_sales_order", String(soId));
    const floor = await resolveShelfLifeFloor(this.db, orgId, clientId);

    let allReserved = true;

    const availabilities = await Promise.all(
      lines.map((line) =>
        this.findAvailableLotForLine(
          orgId,
          line.productVariantId,
          warehouseId,
          line.quantity,
          settings.reservationStrategy,
          settings.expiryReservationPolicy,
          {
            nearExpiryPolicy: settings.nearExpiryPolicy,
            nearExpiryWindowDays: settings.nearExpiryWindowDays,
            minShelfLifeDays: floor.days,
          },
        ),
      ),
    );

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const available = availabilities[i];
      if (!available) {
        allReserved = false;
        continue;
      }

      try {
        await this.reservationService.createReservation(orgId, userId, {
          sourceType: "inv_sales_order",
          sourceId: String(soId),
          sourceLineId: String(line.id),
          productVariantId: line.productVariantId,
          warehouseId: warehouseId ?? undefined,
          locationId: available.locationId,
          lotId: available.lotId,
          qty: line.quantity,
          channelId: channelId ?? null,
        });
      } catch (reserveErr) {
        allReserved = false;
        this.logger.warn(
          `autoReserve: reservation failed for SO ${soId} line ${line.id} in org ${orgId}: ${reserveErr instanceof Error ? reserveErr.message : String(reserveErr)}`,
        );
      }
    }

    const newStatus = allReserved ? "RESERVED" : "PARTIALLY_RESERVED";
    await this.db
      .update(invSalesOrders)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
  }
}
