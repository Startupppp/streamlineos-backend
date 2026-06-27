import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  invPurchaseOrders,
  invPoLines,
  invGrns,
  invGrnLines,
  invStockLevels,
  invStockTransactions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { JournalPostingService } from "../accounting/journal-posting.service";
import type { ListPoInput, CreatePoInput, CreateGrnInput } from "./dto/inv-purchase-orders.schemas";

function computePoTotals(lines: Array<{ quantity: number; unitCost: string; taxRate: string }>) {
  let subtotal = 0;
  let taxAmount = 0;
  for (const l of lines) {
    const lineAmt = l.quantity * parseFloat(l.unitCost);
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
export class InvPurchaseOrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly journalPosting: JournalPostingService,
  ) {}

  private async nextPoNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(invPurchaseOrders)
      .where(eq(invPurchaseOrders.orgId, orgId));
    const cnt = rows[0]?.cnt ?? 0;
    return `PO-${year}-${String(cnt + 1).padStart(4, "0")}`;
  }

  private async nextGrnNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(invGrns)
      .where(eq(invGrns.orgId, orgId));
    const cnt = rows[0]?.cnt ?? 0;
    return `GRN-${year}-${String(cnt + 1).padStart(4, "0")}`;
  }

  async listPos(orgId: string, filters: ListPoInput) {
    const { status, vendorId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${vendorId ?? ""}:${limit}:${offset}`;

    return this.cache.cached(CACHE_KEYS.invPoList(orgId, hash), async () => {
      const conditions = [eq(invPurchaseOrders.orgId, orgId)];
      if (status) conditions.push(eq(invPurchaseOrders.status, status));
      if (vendorId) conditions.push(eq(invPurchaseOrders.vendorId, vendorId));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invPurchaseOrders.findMany({
          where,
          orderBy: [desc(invPurchaseOrders.createdAt)],
          limit,
          offset,
          with: {
            vendor: { columns: { id: true, name: true, code: true } },
            creator: { columns: { id: true, name: true } },
          },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invPurchaseOrders).where(where),
      ]);

      return {
        items,
        total: countResult[0]?.count ?? 0,
        page,
        totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
      };
    }, CACHE_TTL.SHORT);
  }

  async getPo(orgId: string, poId: number) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
      with: {
        vendor: true,
        warehouse: true,
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: {
              with: { product: { columns: { id: true, name: true, sku: true } } },
            },
          },
        },
        grns: {
          with: {
            lines: true,
            creator: { columns: { id: true, name: true } },
          },
        },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    return po;
  }

  async createPo(orgId: string, userId: string, data: CreatePoInput) {
    const poNumber = await this.nextPoNumber(orgId);
    const { subtotal, taxAmount, total } = computePoTotals(data.lines);

    const [po] = await this.db.insert(invPurchaseOrders).values({
      orgId,
      vendorId: data.vendorId,
      poNumber,
      orderDate: data.orderDate,
      expectedDeliveryDate: data.expectedDeliveryDate,
      warehouseId: data.warehouseId,
      subtotal,
      taxAmount,
      discount: "0",
      total,
      currency: data.currency,
      notes: data.notes,
      createdBy: userId,
    }).returning();

    for (const line of data.lines) {
      await this.db.insert(invPoLines).values({
        poId: po.id,
        productVariantId: line.productVariantId,
        quantity: line.quantity.toString(),
        unitCost: line.unitCost,
        taxRate: line.taxRate,
        amount: (line.quantity * parseFloat(line.unitCost)).toFixed(4),
        lineOrder: line.lineOrder,
      });
    }

    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return po;
  }

  async sendPo(orgId: string, poId: number) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
      with: { lines: true },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be sent");

    const sent = await this.db.transaction(async (tx) => {
      const [row] = await tx.update(invPurchaseOrders)
        .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
        .where(eq(invPurchaseOrders.id, poId))
        .returning();

      for (const line of po.lines) {
        const locationId = po.warehouseId ?? 1;
        await tx.insert(invStockLevels).values({
          orgId,
          productVariantId: line.productVariantId,
          locationId,
          onOrder: line.quantity,
        }).onConflictDoUpdate({
          target: [invStockLevels.productVariantId, invStockLevels.locationId],
          set: {
            onOrder: sql`${invStockLevels.onOrder} + ${line.quantity}`,
            updatedAt: new Date(),
          },
        });
      }

      return row;
    });

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return sent;
  }

  async receiveGoods(orgId: string, poId: number, userId: string, data: CreateGrnInput) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
      with: { lines: true, vendor: true },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "SENT" && po.status !== "PARTIAL") {
      throw new BadRequestException("Purchase order must be in SENT or PARTIAL status to receive goods");
    }

    const grnNumber = await this.nextGrnNumber(orgId);
    let totalValue = 0;
    let grnId = 0;

    await this.db.transaction(async (tx) => {
      const [grn] = await tx.insert(invGrns).values({
        orgId,
        poId,
        grnNumber,
        receivedDate: data.receivedDate,
        locationId: data.locationId,
        notes: data.notes,
        createdBy: userId,
      }).returning();
      grnId = grn.id;

      for (const grnLine of data.lines) {
        const poLine = po.lines.find((l) => l.id === grnLine.poLineId);
        if (!poLine) continue;

        await tx.insert(invGrnLines).values({
          grnId: grn.id,
          poLineId: grnLine.poLineId,
          quantityReceived: grnLine.quantityReceived.toString(),
          qualityStatus: grnLine.qualityStatus,
          rejectionReason: grnLine.rejectionReason,
        });

        await tx.update(invPoLines)
          .set({ quantityReceived: sql`${invPoLines.quantityReceived} + ${grnLine.quantityReceived}` })
          .where(eq(invPoLines.id, grnLine.poLineId));

        if (grnLine.qualityStatus === "ACCEPTED") {
          const locationId = data.locationId ?? 1;
          const currentLevel = await tx.query.invStockLevels.findFirst({
            where: and(
              eq(invStockLevels.productVariantId, poLine.productVariantId),
              eq(invStockLevels.locationId, locationId),
            ),
            columns: { onHand: true },
          });
          const before = parseFloat(currentLevel?.onHand ?? "0");
          const after = before + grnLine.quantityReceived;

          await tx.insert(invStockLevels).values({
            orgId,
            productVariantId: poLine.productVariantId,
            locationId,
            onHand: grnLine.quantityReceived.toString(),
          }).onConflictDoUpdate({
            target: [invStockLevels.productVariantId, invStockLevels.locationId],
            set: {
              onHand: sql`${invStockLevels.onHand} + ${grnLine.quantityReceived}`,
              onOrder: sql`GREATEST(0, ${invStockLevels.onOrder} - ${grnLine.quantityReceived})`,
              updatedAt: new Date(),
            },
          });

          await tx.insert(invStockTransactions).values({
            orgId,
            productVariantId: poLine.productVariantId,
            locationId,
            transactionType: "GRN",
            quantityChange: grnLine.quantityReceived.toString(),
            quantityBefore: before.toString(),
            quantityAfter: after.toString(),
            referenceType: "inv_grn",
            referenceId: grn.id.toString(),
            createdBy: userId,
          });

          totalValue += grnLine.quantityReceived * parseFloat(poLine.unitCost);
        }
      }

      const allLines = await tx.query.invPoLines.findMany({ where: eq(invPoLines.poId, poId) });
      const allReceived = allLines.every(
        (l) => parseFloat(l.quantityReceived) >= parseFloat(l.quantity),
      );
      await tx.update(invPurchaseOrders)
        .set({ status: allReceived ? "RECEIVED" : "PARTIAL", updatedAt: new Date() })
        .where(eq(invPurchaseOrders.id, poId));
    });

    if (totalValue > 0) {
      await this.journalPosting.persistJournalEntry({
        orgId,
        entryDate: data.receivedDate,
        description: `Goods received: ${grnNumber}`,
        sourceType: "inv_grn",
        sourceId: poId.toString(),
        sourceEvent: "receive",
        status: "POSTED",
        createdBy: userId,
        lines: [
          {
            accountCode: "1300",
            debit: totalValue,
            credit: 0,
            description: `Inventory received - ${grnNumber}`,
          },
          {
            accountCode: "2000",
            debit: 0,
            credit: totalValue,
            description: `AP - PO ${po.poNumber}`,
          },
        ],
      });
    }

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    await this.cache.del(CACHE_KEYS.invStockSummary(orgId));
    await this.cache.invalidatePattern(`inv:stock:levels:${orgId}:*`);

    return this.db.query.invGrns.findFirst({
      where: eq(invGrns.id, grnId),
      with: {
        lines: true,
        creator: { columns: { id: true, name: true } },
      },
    });
  }
}
