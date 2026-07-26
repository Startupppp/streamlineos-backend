import {
  Inject, Injectable, BadRequestException, NotFoundException, ConflictException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  invSalesOrders, invSoLines, invStockLevels, invProductVariants, invoices, invStockReservations,
  invLots,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { NumberSequenceService } from "../inv-stock-engine/number-sequence.service";
import { InventorySettingsService } from "../inv-stock-engine/inventory-settings.service";
import { ReservationService } from "../inv-stock-engine/reservation.service";
import { JournalPostingService } from "../accounting/journal-posting.service";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { addDec, mulDec } from "../inv-stock-engine/stock-engine.service";
import type { ListSoInput, CreateSoInput, UpdateSoInput, CancelSoInput } from "./dto/inv-sales-orders.schemas";

function computeSoTotals(lines: Array<{ quantity: number; unitPrice: string; taxRate: string }>) {
  let subtotal = "0";
  let taxAmount = "0";
  for (const l of lines) {
    const lineAmt = mulDec(l.quantity.toFixed(4), l.unitPrice);
    subtotal = addDec(subtotal, lineAmt);
    taxAmount = addDec(taxAmount, mulDec(lineAmt, (parseFloat(l.taxRate) / 100).toFixed(10)));
  }
  return {
    subtotal,
    taxAmount,
    total: addDec(subtotal, taxAmount),
  };
}

@Injectable()
export class SoCoreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly settingsService: InventorySettingsService,
    private readonly reservationService: ReservationService,
    private readonly journalPosting: JournalPostingService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async listSos(orgId: string, filters: ListSoInput, scope: DataScope = "all", userId?: string) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, clientId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    const hash = `${status ?? ""}:${clientId ?? ""}:${limit}:${offset}${scopeSuffix}`;

    return this.cache.cached(CACHE_KEYS.invSoList(orgId, hash), async () => {
      const conditions = [eq(invSalesOrders.orgId, orgId)];
      if (status) conditions.push(eq(invSalesOrders.status, status));
      if (clientId) conditions.push(eq(invSalesOrders.clientId, clientId));
      if (scope !== "all" && userId) {
        conditions.push(applyScope(scope, userId, { ownerColumn: invSalesOrders.createdBy }));
      }
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invSalesOrders.findMany({
          where,
          orderBy: [desc(invSalesOrders.createdAt)],
          limit,
          offset,
          with: {
            client: { columns: { id: true, name: true } },
            creator: { columns: { id: true, name: true } },
          },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invSalesOrders).where(where),
      ]);

      return {
        items,
        total: countResult[0]?.count ?? 0,
        page,
        totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
      };
    }, CACHE_TTL.SHORT);
  }

  async getSo(orgId: string, soId: number) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: {
        client: true,
        warehouse: true,
        invoice: true,
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: {
              with: { product: { columns: { id: true, name: true, sku: true } } },
            },
          },
        },
      },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    return so;
  }

  async createSo(orgId: string, userId: string, data: CreateSoInput) {
    const soNumber = await this.numSeq.next(orgId, "SO");
    const { subtotal, taxAmount, total } = computeSoTotals(data.lines);

    const variantIds = data.lines.map((l) => l.productVariantId);
    const variants = await this.db.query.invProductVariants.findMany({
      where: inArray(invProductVariants.id, variantIds),
      columns: { id: true, costPrice: true },
    });
    const variantCostMap = new Map(variants.map((v) => [v.id, v.costPrice]));

    const so = await this.db.transaction(async (tx) => {
      const [header] = await (tx as Db).insert(invSalesOrders).values({
        orgId,
        clientId: data.clientId,
        soNumber,
        orderDate: data.orderDate,
        requiredDate: data.requiredDate,
        shippingAddress: data.shippingAddress,
        warehouseId: data.warehouseId,
        subtotal,
        taxAmount,
        discount: "0",
        total,
        currency: data.currency,
        notes: data.notes,
        createdBy: userId,
      }).returning();

      await (tx as Db).insert(invSoLines).values(
        data.lines.map((line) => ({
          soId: header.id,
          productVariantId: line.productVariantId,
          quantity: line.quantity.toString(),
          unitPrice: line.unitPrice,
          taxRate: line.taxRate,
          amount: mulDec(line.quantity.toFixed(4), line.unitPrice),
          costAtTime: variantCostMap.get(line.productVariantId) ?? "0",
          lineOrder: line.lineOrder,
        }))
      );

      return header;
    });

    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
    return so;
  }

  async updateSo(orgId: string, soId: number, data: UpdateSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "DRAFT") throw new BadRequestException("Only DRAFT sales orders can be updated");

    const patch: Partial<typeof invSalesOrders.$inferInsert> = {};
    if (data.clientId !== undefined) patch.clientId = data.clientId;
    if (data.orderDate !== undefined) patch.orderDate = data.orderDate;
    if (data.requiredDate !== undefined) patch.requiredDate = data.requiredDate;
    if (data.shippingAddress !== undefined) patch.shippingAddress = data.shippingAddress;
    if (data.warehouseId !== undefined) patch.warehouseId = data.warehouseId;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.notes !== undefined) patch.notes = data.notes;

    let variantCostMap = new Map<number, string>();
    if (data.lines) {
      const { subtotal, taxAmount, total } = computeSoTotals(data.lines);
      patch.subtotal = subtotal;
      patch.taxAmount = taxAmount;
      patch.total = total;

      const variantIds = data.lines.map((l) => l.productVariantId);
      const variants = await this.db.query.invProductVariants.findMany({
        where: inArray(invProductVariants.id, variantIds),
        columns: { id: true, costPrice: true },
      });
      variantCostMap = new Map(variants.map((v) => [v.id, v.costPrice]));
    }

    await this.db.transaction(async (tx) => {
      if (data.lines) {
        await (tx as Db).delete(invSoLines).where(eq(invSoLines.soId, soId));

        await (tx as Db).insert(invSoLines).values(
          (data.lines ?? []).map((line) => ({
            soId,
            productVariantId: line.productVariantId,
            quantity: line.quantity.toString(),
            unitPrice: line.unitPrice,
            taxRate: line.taxRate,
            amount: mulDec(line.quantity.toFixed(4), line.unitPrice),
            costAtTime: variantCostMap.get(line.productVariantId) ?? "0",
            lineOrder: line.lineOrder,
          }))
        );
      }

      if (Object.keys(patch).length > 0) {
        await (tx as Db).update(invSalesOrders)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
      }
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
    return this.getSo(orgId, soId);
  }

  async confirmSo(orgId: string, soId: number, userId: string) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "DRAFT") throw new BadRequestException("Only DRAFT sales orders can be confirmed");

    const settings = await this.settingsService.get(orgId);

    await this.db.update(invSalesOrders)
      .set({ status: "CONFIRMED", confirmedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

    if (settings.autoReserveOnConfirm) {
      try {
        await this._autoReserve(orgId, soId, userId, so.lines, so.warehouseId);
      } catch {
        // confirm succeeds even if auto-reserve fails
      }
    }

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
  }

  private async _autoReserve(
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
      if (!available) { allReserved = false; continue; }

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
      } catch {
        allReserved = false;
      }
    }

    const newStatus = allReserved ? "RESERVED" : "PARTIALLY_RESERVED";
    await this.db.update(invSalesOrders)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
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
      columns: { id: true, locationId: true, lotId: true, onHand: true, committed: true, blockedQty: true, qualityHoldQty: true },
    });

    const filtered = levels.filter((l) => {
      if (warehouseId && l.location?.warehouseId !== warehouseId) return false;
      const available = parseFloat(l.onHand) - parseFloat(l.committed) - parseFloat(l.blockedQty ?? "0") - parseFloat(l.qualityHoldQty ?? "0");
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
      const match = filtered.sort((a, b) => (a.lotId ?? 0) - (b.lotId ?? 0)).find((l) => l.lotId !== null);
      if (match) return { locationId: match.locationId, lotId: match.lotId ?? undefined };
    }

    const anyMatch = filtered[0];
    if (!anyMatch) return null;
    return { locationId: anyMatch.locationId, lotId: anyMatch.lotId ?? undefined };
  }

  async cancelSo(orgId: string, soId: number, userId: string, _data: CancelSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status === "SHIPPED" || so.status === "PARTIALLY_SHIPPED" || so.status === "INVOICED") {
      throw new BadRequestException("Cannot cancel a sales order that has been shipped or invoiced");
    }
    if (so.status === "CANCELLED") throw new BadRequestException("Sales order is already cancelled");

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
        await this.reservationService.releaseReservationInTx(tx, orgId, userId, res.id);
      }

      await (tx as Db).update(invSalesOrders)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
  }

  async invoiceSo(orgId: string, soId: number, userId: string) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: {
        lines: {
          with: { productVariant: { with: { product: { columns: { id: true, name: true } } } } },
        },
      },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "SHIPPED" && so.status !== "PARTIALLY_SHIPPED") {
      throw new BadRequestException("Only SHIPPED or PARTIALLY_SHIPPED sales orders can be invoiced");
    }
    if (so.invoiceId) throw new ConflictException("This sales order has already been invoiced");

    await this.planLimits.assertWithinLimit(orgId, "acctInvoices");

    const invoiceNumber = await this.numSeq.next(orgId, "INVOICE");
    const lineItems = so.lines.map((l) => ({
      description: l.productVariant.product.name,
      quantity: parseFloat(l.quantity),
      rate: parseFloat(l.unitPrice),
      amount: parseFloat(l.amount),
    }));

    const today = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [invoice] = await this.db.insert(invoices).values({
      orgId,
      clientId: so.clientId,
      invoiceNumber,
      status: "ISSUED",
      lineItems,
      subtotal: so.subtotal,
      taxRate: "0",
      taxAmount: so.taxAmount,
      discount: "0",
      total: so.total,
      currency: so.currency,
      dueDate,
      createdBy: userId,
    }).returning();

    await this.db.update(invSalesOrders)
      .set({ status: "INVOICED", invoiceId: invoice.id, updatedAt: new Date() })
      .where(and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)));

    await this.journalPosting.persistJournalEntry({
      orgId,
      entryDate: today,
      description: `Invoice: ${invoiceNumber}`,
      sourceType: "inv_sales_order",
      sourceId: soId.toString(),
      sourceEvent: "invoice",
      status: "POSTED",
      createdBy: userId,
      lines: [
        { accountCode: "1200", debit: Number(so.total), credit: 0, description: `AR - ${invoiceNumber}` },
        { accountCode: "4000", debit: 0, credit: Number(so.total), description: `Sales Revenue - ${so.soNumber}` },
      ],
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
    return invoice;
  }

  async getAtp(orgId: string, productVariantIds: number[]) {
    if (productVariantIds.length === 0) return [];

    const levels = await this.db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, productVariantIds),
      ),
      columns: { productVariantId: true, onHand: true, committed: true, onOrder: true, blockedQty: true, qualityHoldQty: true },
    });

    const grouped = new Map<number, { onHand: number; committed: number; onOrder: number; blocked: number; qualityHold: number }>();

    for (const l of levels) {
      const existing = grouped.get(l.productVariantId);
      const onHand = parseFloat(l.onHand);
      const committed = parseFloat(l.committed);
      const onOrder = parseFloat(l.onOrder);
      const blocked = parseFloat(l.blockedQty ?? "0");
      const qualityHold = parseFloat(l.qualityHoldQty ?? "0");

      if (existing) {
        existing.onHand += onHand;
        existing.committed += committed;
        existing.onOrder += onOrder;
        existing.blocked += blocked;
        existing.qualityHold += qualityHold;
      } else {
        grouped.set(l.productVariantId, { onHand, committed, onOrder, blocked, qualityHold });
      }
    }

    return productVariantIds.map((id) => {
      const agg = grouped.get(id);
      const onHand = agg?.onHand ?? 0;
      const committed = agg?.committed ?? 0;
      const blocked = agg?.blocked ?? 0;
      const qualityHold = agg?.qualityHold ?? 0;
      const onOrder = agg?.onOrder ?? 0;
      return {
        productVariantId: id,
        onHand,
        committed,
        blocked,
        qualityHold,
        onOrder,
        available: onHand - committed - blocked - qualityHold,
        incomingQty: onOrder,
        outgoingQty: committed,
      };
    });
  }
}
