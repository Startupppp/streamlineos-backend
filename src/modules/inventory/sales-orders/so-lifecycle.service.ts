import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
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
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import { AdapterRejection } from "../../accounting/adapters/posting-command.types";
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
    private readonly posting: PostingCommandService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async confirmSo(orgId: string, soId: number, userId: string) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "DRAFT")
      throw new BadRequestException("Only DRAFT sales orders can be confirmed");

    const settings = await this.settingsService.get(orgId);

    await this.db
      .update(invSalesOrders)
      .set({ status: "CONFIRMED", confirmedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

    if (settings.autoReserveOnConfirm) {
      try {
        await this.autoReserve(orgId, soId, userId, so.lines, so.warehouseId);
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

    await this.db.transaction(async (tx) => {
      for (const res of reservations) {
        await this.reservationService.releaseReservationInTx(
          tx,
          orgId,
          userId,
          res.id,
        );
      }

      await (tx as Db)
        .update(invSalesOrders)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
        );
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

    // Gross-to-revenue, exactly as before: the sales order carries no tax
    // determination, so splitting the total here would be inventing one.
    const totalMinor = Math.round(Number(so.total) * 100);
    try {
      await this.posting.submit(orgId, userId, {
        sourceType: "sales_invoice",
        sourceId: String(invoice.id),
        purpose: "issue",
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
      });
    } catch (error) {
      // Accounting is opt-in; an org without a book has nowhere to post and
      // must still be able to invoice a sales order.
      // Contract: docs/inventory-gl-contract.md (§3.3 for the post-commit
      // ordering this shares with the other two bridge call sites).
      if (!(error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED")) throw error;
      this.logger.debug(`Accounting is not enabled for org ${orgId}; ${invoiceNumber} was not posted`);
    }

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return invoice;
  }

  async findAvailableLotForLine(
    orgId: string,
    variantId: number,
    warehouseId: number | null | undefined,
    qty: number,
    strategy: string,
    expiryPolicy: string,
  ): Promise<{ locationId: number; lotId?: number } | null> {
    const conditions = [
      eq(invStockLevels.orgId, orgId),
      eq(invStockLevels.productVariantId, variantId),
    ];

    const levels = await this.db.query.invStockLevels.findMany({
      where: and(...conditions),
      with: {
        location: { columns: { id: true, warehouseId: true } },
      },
      columns: {
        id: true,
        locationId: true,
        lotId: true,
        onHand: true,
        committed: true,
        blockedQty: true,
        qualityHoldQty: true,
      },
    });

    const filtered = levels.filter((l) => {
      if (warehouseId && l.location?.warehouseId !== warehouseId) return false;
      const available =
        parseFloat(l.onHand) -
        parseFloat(l.committed) -
        parseFloat(l.blockedQty ?? "0") -
        parseFloat(l.qualityHoldQty ?? "0");
      return available >= qty;
    });

    if (filtered.length === 0) return null;

    if (strategy === "FEFO" && filtered.some((l) => l.lotId !== null)) {
      const lotsWithExpiry = await this.db.query.invLots.findMany({
        where: and(
          eq(invLots.orgId, orgId),
          eq(invLots.productVariantId, variantId),
        ),
        columns: { id: true, expiryDate: true, status: true },
        orderBy: (t, { asc }) => [asc(t.expiryDate)],
      });
      if (lotsWithExpiry) {
        for (const lot of lotsWithExpiry) {
          if (lot.status !== "ACTIVE") continue;
          if (expiryPolicy === "BLOCK" && lot.expiryDate) {
            const today = new Date().toISOString().slice(0, 10);
            if (lot.expiryDate <= today) continue;
          }
          const match = filtered.find((l) => l.lotId === lot.id);
          if (match) return { locationId: match.locationId, lotId: lot.id };
        }
      }
      if (expiryPolicy === "BLOCK") return null;
    }

    if (strategy === "FIFO" && filtered.some((l) => l.lotId !== null)) {
      const match = filtered
        .sort((a, b) => (a.lotId ?? 0) - (b.lotId ?? 0))
        .find((l) => l.lotId !== null);
      if (match)
        return {
          locationId: match.locationId,
          lotId: match.lotId ?? undefined,
        };
    }

    const anyMatch = filtered[0];
    if (!anyMatch) return null;
    return {
      locationId: anyMatch.locationId,
      lotId: anyMatch.lotId ?? undefined,
    };
  }

  private async autoReserve(
    orgId: string,
    soId: number,
    userId: string,
    lines: Array<{ id: number; productVariantId: number; quantity: string }>,
    warehouseId: number | null | undefined,
  ) {
    const settings = await this.settingsService.get(orgId);
    let allReserved = true;

    const availabilities = await Promise.all(
      lines.map((line) =>
        this.findAvailableLotForLine(
          orgId,
          line.productVariantId,
          warehouseId,
          parseFloat(line.quantity),
          settings.reservationStrategy,
          settings.expiryReservationPolicy,
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
