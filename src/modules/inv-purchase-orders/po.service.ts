import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import {
  invPurchaseOrders,
  invPoLines,
  invGrns,
  invLocations,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { InventorySettingsService } from "../inv-stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../inv-stock-engine/number-sequence.service";
import type { ListPoInput, CreatePoInput, UpdatePoInput } from "./dto/inv-purchase-orders.schemas";

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
export class PoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly settingsService: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
  ) {}

  async resolveLocationId(orgId: string, warehouseId: number | null | undefined): Promise<number> {
    if (!warehouseId) throw new BadRequestException("A warehouse is required for this operation");
    const loc = await this.db.query.invLocations.findFirst({
      where: and(
        eq(invLocations.warehouseId, warehouseId),
        eq(invLocations.orgId, orgId),
        eq(invLocations.isActive, true),
      ),
      columns: { id: true },
      orderBy: (t, { asc }) => [asc(t.id)],
    });
    if (!loc) throw new BadRequestException("Warehouse has no active locations");
    return loc.id;
  }

  async listPos(orgId: string, filters: ListPoInput, scope: DataScope = "all", userId?: string) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, vendorId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    const hash = `${status ?? ""}:${vendorId ?? ""}:${limit}:${offset}${scopeSuffix}`;

    return this.cache.cached(CACHE_KEYS.invPoList(orgId, hash), async () => {
      const conditions = [eq(invPurchaseOrders.orgId, orgId)];
      if (status) conditions.push(eq(invPurchaseOrders.status, status));
      if (vendorId) conditions.push(eq(invPurchaseOrders.vendorId, vendorId));
      if (scope !== "all" && userId) {
        conditions.push(applyScope(scope, userId, { ownerColumn: invPurchaseOrders.createdBy }));
      }
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
    const poNumber = await this.numSeq.next(orgId, "PO");
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

    await this.db.insert(invPoLines).values(
      data.lines.map((line) => ({
        poId: po.id,
        productVariantId: line.productVariantId,
        quantity: line.quantity.toString(),
        unitCost: line.unitCost,
        taxRate: line.taxRate,
        amount: (line.quantity * parseFloat(line.unitCost)).toFixed(4),
        lineOrder: line.lineOrder,
      }))
    );

    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return po;
  }

  async updatePo(orgId: string, poId: number, data: UpdatePoInput) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be updated");

    const patch: Partial<typeof invPurchaseOrders.$inferInsert> = {};
    if (data.vendorId !== undefined) patch.vendorId = data.vendorId;
    if (data.orderDate !== undefined) patch.orderDate = data.orderDate;
    if (data.expectedDeliveryDate !== undefined) patch.expectedDeliveryDate = data.expectedDeliveryDate;
    if (data.warehouseId !== undefined) patch.warehouseId = data.warehouseId;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.notes !== undefined) patch.notes = data.notes;

    if (data.lines) {
      const { subtotal, taxAmount, total } = computePoTotals(data.lines);
      patch.subtotal = subtotal;
      patch.taxAmount = taxAmount;
      patch.total = total;

      await this.db.delete(invPoLines).where(eq(invPoLines.poId, poId));
      await this.db.insert(invPoLines).values(
        data.lines.map((line) => ({
          poId,
          productVariantId: line.productVariantId,
          quantity: line.quantity.toString(),
          unitCost: line.unitCost,
          taxRate: line.taxRate,
          amount: (line.quantity * parseFloat(line.unitCost)).toFixed(4),
          lineOrder: line.lineOrder,
        }))
      );
    }

    if (Object.keys(patch).length > 0) {
      await this.db.update(invPurchaseOrders)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)));
    }

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return this.getPo(orgId, poId);
  }

  async approvePo(orgId: string, poId: number, userId: string) {
    const settings = await this.settingsService.get(orgId);
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be approved");

    const newStatus = settings.requirePoApproval ? "SENT" : "SENT";

    const [updated] = await this.db.update(invPurchaseOrders)
      .set({ status: newStatus, approvedBy: userId, approvedAt: new Date(), sentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return updated;
  }

  async sendPo(orgId: string, poId: number) {
    const settings = await this.settingsService.get(orgId);
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be sent");

    if (settings.requirePoApproval && !po.approvedBy) {
      throw new BadRequestException("This purchase order requires approval before sending");
    }

    const [sent] = await this.db.update(invPurchaseOrders)
      .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return sent;
  }

  async closePo(orgId: string, poId: number) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "RECEIVED" && po.status !== "PARTIAL") {
      throw new BadRequestException("Only RECEIVED or PARTIAL purchase orders can be closed");
    }

    const [closed] = await this.db.update(invPurchaseOrders)
      .set({ status: "CLOSED", updatedAt: new Date() })
      .where(eq(invPurchaseOrders.id, poId))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return closed;
  }

  async cancelPo(orgId: string, poId: number) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "DRAFT" && po.status !== "SENT") {
      throw new BadRequestException("Only DRAFT or SENT purchase orders can be cancelled");
    }

    const grnCount = await this.db.select({ cnt: sql<number>`count(*)::int` })
      .from(invGrns)
      .where(and(eq(invGrns.poId, poId), eq(invGrns.orgId, orgId)));

    if ((grnCount[0]?.cnt ?? 0) > 0) {
      throw new BadRequestException("Cannot cancel a purchase order that has already received goods");
    }

    const [cancelled] = await this.db.update(invPurchaseOrders)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(invPurchaseOrders.id, poId))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidatePattern(`inv:po:list:${orgId}:*`);
    return cancelled;
  }
}
