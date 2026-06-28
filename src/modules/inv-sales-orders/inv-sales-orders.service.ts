import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  invSalesOrders,
  invSoLines,
  invStockLevels,
  invStockTransactions,
  invProductVariants,
  invoices,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { JournalPostingService } from "../accounting/journal-posting.service";
import type { ListSoInput, CreateSoInput, ShipSoInput } from "./dto/inv-sales-orders.schemas";

function computeSoTotals(lines: Array<{ quantity: number; unitPrice: string; taxRate: string }>) {
  let subtotal = 0;
  let taxAmount = 0;
  for (const l of lines) {
    const lineAmt = l.quantity * parseFloat(l.unitPrice);
    subtotal += lineAmt;
    taxAmount += lineAmt * (parseFloat(l.taxRate) / 100);
  }
  return {
    subtotal: subtotal.toFixed(4),
    taxAmount: taxAmount.toFixed(4),
    total: (subtotal + taxAmount).toFixed(4),
  };
}

@Injectable()
export class InvSalesOrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly journalPosting: JournalPostingService,
  ) {}

  private async nextSoNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(invSalesOrders)
      .where(eq(invSalesOrders.orgId, orgId));
    const cnt = rows[0]?.cnt ?? 0;
    return `SO-${year}-${String(cnt + 1).padStart(4, "0")}`;
  }

  private async nextInvoiceNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(invoices)
      .where(eq(invoices.orgId, orgId));
    const cnt = rows[0]?.cnt ?? 0;
    return `INV-${year}-${String(cnt + 1).padStart(4, "0")}`;
  }

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
    const soNumber = await this.nextSoNumber(orgId);
    const { subtotal, taxAmount, total } = computeSoTotals(data.lines);

    const [so] = await this.db.insert(invSalesOrders).values({
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

    const variantIds = data.lines.map((l) => l.productVariantId);
    const variants = await this.db.query.invProductVariants.findMany({
      where: inArray(invProductVariants.id, variantIds),
      columns: { id: true, costPrice: true },
    });
    const variantCostMap = new Map(variants.map((v) => [v.id, v.costPrice]));

    await this.db.insert(invSoLines).values(
      data.lines.map((line) => ({
        soId: so.id,
        productVariantId: line.productVariantId,
        quantity: line.quantity.toString(),
        unitPrice: line.unitPrice,
        taxRate: line.taxRate,
        amount: (line.quantity * parseFloat(line.unitPrice)).toFixed(4),
        costAtTime: variantCostMap.get(line.productVariantId) ?? "0",
        lineOrder: line.lineOrder,
      }))
    );

    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
    return so;
  }

  async confirmSo(orgId: string, soId: number, userId: string): Promise<void> {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "DRAFT") throw new BadRequestException("Only DRAFT sales orders can be confirmed");

    const soVariantIds = so.lines.map((l) => l.productVariantId);
    const stockLevels = await this.db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, soVariantIds),
      ),
      columns: { productVariantId: true, onHand: true, committed: true },
    });
    const stockMap = new Map(stockLevels.map((s) => [s.productVariantId, s]));

    for (const line of so.lines) {
      const level = stockMap.get(line.productVariantId);
      const available = parseFloat(level?.onHand ?? "0") - parseFloat(level?.committed ?? "0");
      if (available < parseFloat(line.quantity)) {
        throw new BadRequestException(
          `Insufficient stock for variant ${line.productVariantId}. Available: ${available}`,
        );
      }
    }

    const locationId = so.warehouseId ?? 1;
    await this.db.transaction(async (tx) => {
      for (const line of so.lines) {
        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId,
          committed: line.quantity,
        }).onConflictDoUpdate({
          target: [invStockLevels.productVariantId, invStockLevels.locationId],
          set: {
            committed: sql`${invStockLevels.committed} + ${line.quantity}`,
            updatedAt: new Date(),
          },
        });
      }

      await tx.update(invSalesOrders)
        .set({ status: "CONFIRMED", confirmedAt: new Date(), updatedAt: new Date() })
        .where(eq(invSalesOrders.id, soId));
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
    await this.cache.invalidatePattern(`inv:stock:levels:${orgId}:*`);
  }

  async shipSo(orgId: string, soId: number, userId: string, data: ShipSoInput): Promise<void> {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "CONFIRMED") throw new BadRequestException("Only CONFIRMED sales orders can be shipped");

    const locationId = so.warehouseId ?? 1;
    const shipVariantIds = so.lines.map((l) => l.productVariantId);
    const preLevels = await this.db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, shipVariantIds),
        eq(invStockLevels.locationId, locationId),
      ),
      columns: { productVariantId: true, onHand: true },
    });
    const preLevelMap = new Map(preLevels.map((s) => [s.productVariantId, parseFloat(s.onHand)]));

    let cogsTotal = 0;

    await this.db.transaction(async (tx) => {
      for (const line of so.lines) {
        const before = preLevelMap.get(line.productVariantId) ?? 0;
        const qty = parseFloat(line.quantity);
        const after = before - qty;

        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId,
          onHand: "0",
        }).onConflictDoUpdate({
          target: [invStockLevels.productVariantId, invStockLevels.locationId],
          set: {
            onHand: sql`${invStockLevels.onHand} - ${line.quantity}`,
            committed: sql`GREATEST(0, ${invStockLevels.committed} - ${line.quantity})`,
            updatedAt: new Date(),
          },
        });

        await tx.insert(invStockTransactions).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId,
          transactionType: "SALE",
          quantityChange: `-${line.quantity}`,
          quantityBefore: before.toString(),
          quantityAfter: after.toString(),
          referenceType: "inv_sales_order",
          referenceId: soId.toString(),
          createdBy: userId,
        });

        await tx.update(invSoLines)
          .set({ quantityShipped: sql`${invSoLines.quantityShipped} + ${line.quantity}` })
          .where(eq(invSoLines.id, line.id));

        cogsTotal += qty * parseFloat(line.costAtTime);
      }

      await tx.update(invSalesOrders)
        .set({ status: "SHIPPED", shippedAt: new Date(), updatedAt: new Date() })
        .where(eq(invSalesOrders.id, soId));
    });

    if (cogsTotal > 0) {
      const soData = await this.db.query.invSalesOrders.findFirst({
        where: eq(invSalesOrders.id, soId),
        columns: { soNumber: true },
      });
      await this.journalPosting.persistJournalEntry({
        orgId,
        entryDate: data.shipDate,
        description: `COGS: ${soData?.soNumber ?? soId}`,
        sourceType: "inv_sales_order",
        sourceId: soId.toString(),
        sourceEvent: "ship",
        status: "POSTED",
        createdBy: userId,
        lines: [
          {
            accountCode: "5000",
            debit: cogsTotal,
            credit: 0,
            description: `COGS - SO-${soId}`,
          },
          {
            accountCode: "1300",
            debit: 0,
            credit: cogsTotal,
            description: `Inventory deducted - SO-${soId}`,
          },
        ],
      });
    }

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidatePattern(`inv:so:list:${orgId}:*`);
    await this.cache.del(CACHE_KEYS.invStockSummary(orgId));
    await this.cache.invalidatePattern(`inv:stock:levels:${orgId}:*`);
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
    if (so.status !== "SHIPPED") throw new BadRequestException("Only SHIPPED sales orders can be invoiced");
    if (so.invoiceId) throw new ConflictException("This sales order has already been invoiced");

    const invoiceNumber = await this.nextInvoiceNumber(orgId);

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
      status: "SENT",
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
      .where(eq(invSalesOrders.id, soId));

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
      columns: { productVariantId: true, onHand: true, committed: true, onOrder: true },
    });
    const levelMap = new Map(levels.map((l) => [l.productVariantId, l]));

    return productVariantIds.map((id) => {
      const level = levelMap.get(id);
      const onHand = parseFloat(level?.onHand ?? "0");
      const committed = parseFloat(level?.committed ?? "0");
      return {
        productVariantId: id,
        onHand,
        committed,
        onOrder: parseFloat(level?.onOrder ?? "0"),
        available: onHand - committed,
      };
    });
  }
}
