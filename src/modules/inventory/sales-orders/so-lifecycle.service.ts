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
  invSalesOrders,
  invStockReservations,
  invoiceItems,
  invoices,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { type EligibilityPolicy } from "./lot-eligibility";
import { clientBehindSource, resolveShelfLifeFloor } from "../settings/min-shelf-life";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import { AdapterRejection } from "../../accounting/adapters/posting-command.types";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { findAvailableLotForLine } from "./lib/lot-selection";

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
    private readonly posting: PostingCommandService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  /**
   * A3/T04. Confirming took no key. The DRAFT guard makes a repeat safe, but a
   * client retrying a timed-out confirm was told the order could not be
   * confirmed — when it already had been, and had auto-reserved stock on the
   * way. Replaying the original answer is what the key is for.
   *
   * The key was added and the guard was left in front of it, so the sentence
   * above stayed true: the first call sets CONFIRMED, and the retry was refused
   * with a 400 on the status its own first run had set. The DRAFT check now runs
   * inside the claim.
   *
   * The order is still read out here, because `autoReserve` below needs its lines
   * after the transaction commits. That read is not the guard — the guard is the
   * one inside, against `tx`.
   */
  async confirmSo(orgId: string, soId: number, userId: string, idempotencyKey: string) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");

    const settings = await this.settingsService.get(orgId);

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.sales-orders.confirm", soId },
        async () => {
          // Read through `tx` so the check sees the same snapshot the write does.
          const [current] = await tx
            .select({ status: invSalesOrders.status })
            .from(invSalesOrders)
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)))
            .limit(1);
          if (!current) throw new NotFoundException("Sales order not found");
          if (current.status !== "DRAFT")
            throw new BadRequestException("Only DRAFT sales orders can be confirmed");

          await tx
            .update(invSalesOrders)
            .set({ status: "CONFIRMED", confirmedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
          return { confirmed: soId };
        },
        () => ({ confirmed: soId }),
      ),
    );

    // T04/§4. Auto-reserve cannot join the idempotent unit — `reserve` opens its own
    // transaction — so it is a side effect after the claim, and §4's question is what
    // a crash between the two costs. It is recoverable from state already stored: an
    // order that committed CONFIRMED and never reserved is still sitting at CONFIRMED,
    // and the reserve can be re-driven from the order's own lines.
    //
    // So the condition is "is there anything left to do?", not "was this a replay?".
    // Both of the obvious alternatives are wrong in opposite directions. Reserving
    // unconditionally double-reserves on a retry, moving a RESERVED order to
    // PARTIALLY_RESERVED — idempotent from the outside and not underneath, which is
    // the defect the recall fix named. Reserving only on a fresh execution is worse
    // and quieter: a crash after the confirm commit and before the reserve leaves the
    // order CONFIRMED for ever, because every retry then skips the reserve.
    //
    // Reading the status answers both. Auto-reserve always moves the order off
    // CONFIRMED when it runs — to RESERVED, or to PARTIALLY_RESERVED when the shelf
    // life floor or short stock removed candidates — so CONFIRMED means it has not run.
    const [afterConfirm] = await this.db
      .select({ status: invSalesOrders.status })
      .from(invSalesOrders)
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)))
      .limit(1);

    if (settings.autoReserveOnConfirm && afterConfirm?.status === "CONFIRMED") {
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
      handling_unit_id: number | null;
      quantity: string;
    }>(sql`
      SELECT pll.product_variant_id, pll.location_id, pll.lot_id, pll.serial_id,
             pll.handling_unit_id,
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
             pll.handling_unit_id,
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
      await tx
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
          handlingUnitId: row.handling_unit_id,
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

    /*
      One transaction over the invoice, its lines, the sales order's status and
      the journal. Before this the four ran as four separate statements and were
      atomic only because a request interceptor happened to wrap the handler —
      see `docs/inventory-gl-contract.md` §3.3. An invoice row with no journal,
      or a sales order marked INVOICED against an invoice that was rolled back,
      are both states nothing here could recover from.
    */
    const invoice = await this.db.transaction(async (tx) => {
      const [created] = await tx
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
        await tx.insert(invoiceItems).values(
          lineItems.map((line, index) => ({
            invoiceId: created.id,
            description: line.description,
            quantity: line.quantity.toFixed(4),
            rate: line.rate.toFixed(4),
            gstRate: "0",
            amount: line.amount.toFixed(4),
            lineOrder: index,
          })),
        );
      }

      await tx
        .update(invSalesOrders)
        .set({ status: "INVOICED", invoiceId: created.id, updatedAt: new Date() })
        .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

      // Gross-to-revenue, exactly as before: the sales order carries no tax
      // determination, so splitting the total here would be inventing one.
      const totalMinor = Math.round(Number(so.total) * 100);
      try {
        await this.posting.submit(
          orgId,
          userId,
          {
            sourceType: "sales_invoice",
            sourceId: String(created.id),
            /*
              `post`, matching `invoices-posting.service.ts`, and not `issue`.
              Both write into the same `invoices` table and the same serial id
              space, so two purposes meant two idempotency keys for one
              document — and `invoices-update.service.ts` posts whenever a
              status moves TO `ISSUED` from anything else. An invoice this path
              created (already `ISSUED`) could be patched to `VOIDED` and back,
              and the second journal would go through: AR control and sales
              revenue counted twice, with no error anywhere. One purpose makes
              the idempotency key do the deduplication it exists for. See
              `docs/adr-legacy-invoices-vs-ar.md`.
            */
            purpose: "post",
            journalDate: today,
            memo: `Invoice: ${invoiceNumber}`,
            lines: [
              {
                accountTag: "ar_control",
                debitMinor: totalMinor,
                description: `AR - ${invoiceNumber}`,
              },
              {
                accountTag: "sales",
                creditMinor: totalMinor,
                description: `Sales Revenue - ${so.soNumber}`,
              },
            ],
          },
          tx,
        );
      } catch (error) {
        // Accounting is opt-in; an org without a book has nowhere to post and
        // must still be able to invoice a sales order. Anything else rolls the
        // invoice back with it, which is the point of the transaction.
        if (!(error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED")) throw error;
        this.logger.debug(`Accounting is not enabled for org ${orgId}; ${invoiceNumber} was not posted`);
      }

      return created;
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return invoice;
  }

  /** @see lib/lot-selection.ts — three picking services reach this through SoCoreService. */
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
  ): Promise<{ locationId: number; lotId?: number; handlingUnitId?: number } | null> {
    return findAvailableLotForLine(this.db, orgId, variantId, warehouseId, qty, strategy, expiryPolicy, constraints);
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
        findAvailableLotForLine(this.db, 
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
          handlingUnitId: available.handlingUnitId ?? null,
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
