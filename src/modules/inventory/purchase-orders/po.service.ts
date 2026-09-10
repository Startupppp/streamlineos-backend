import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { ScopedRead } from "../../access/scoped-read";
import {
  invPurchaseOrders,
  invPoLines,
  invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { addDec, mulDec } from "../stock-engine/stock-engine.service";
import {
  approvePo as runApprovePo,
  cancelPo as runCancelPo,
  closePo as runClosePo,
  sendPo as runSendPo,
  type PoLifecycleDeps,
} from "./po-lifecycle";
import type { ListPoInput, CreatePoInput, UpdatePoInput } from "./dto/inv-purchase-orders.schemas";

function computePoTotals(lines: Array<{ quantity: number; unitCost: string; taxRate: string }>) {
  let subtotal = "0.0000";
  let taxAmount = "0.0000";
  for (const l of lines) {
    const lineAmt = mulDec(String(l.quantity), l.unitCost);
    subtotal = addDec(subtotal, lineAmt);
    const lineTax = mulDec(lineAmt, mulDec(l.taxRate, "0.01"));
    taxAmount = addDec(taxAmount, lineTax);
  }
  return {
    subtotal,
    taxAmount,
    total: addDec(subtotal, taxAmount),
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

  async listPos(read: ScopedRead, filters: ListPoInput) {
    const orgId = read.orgId;
    const { status, vendorId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${vendorId ?? ""}:${limit}:${offset}:${read.discriminator}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invPoNamespace(orgId), hash, () =>
      read.read(
        {
          tenant: invPurchaseOrders.orgId,
          scope: { columns: { ownerColumn: invPurchaseOrders.createdBy } },
          and: [
            status ? eq(invPurchaseOrders.status, status) : undefined,
            vendorId ? eq(invPurchaseOrders.vendorId, vendorId) : undefined,
          ],
        },
        async ({ sql: where }) => {
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
        },
        () => ({ items: [], total: 0, page, totalPages: 0 }),
      ),
    CACHE_TTL.SHORT);
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
        amount: mulDec(String(line.quantity), line.unitCost),
        lineOrder: line.lineOrder,
      }))
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
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
          amount: mulDec(String(line.quantity), line.unitCost),
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
    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return this.getPo(orgId, poId);
  }

  async approvePo(orgId: string, poId: number, userId: string) {
    return runApprovePo(this.lifecycleDeps(), orgId, poId, userId);
  }

  async sendPo(orgId: string, poId: number) {
    return runSendPo(this.lifecycleDeps(), orgId, poId);
  }

  async closePo(orgId: string, poId: number) {
    return runClosePo(this.lifecycleDeps(), orgId, poId);
  }

  async cancelPo(orgId: string, poId: number) {
    return runCancelPo(this.lifecycleDeps(), orgId, poId);
  }

  private lifecycleDeps(): PoLifecycleDeps {
    return { db: this.db, cache: this.cache, settingsService: this.settingsService };
  }
}
