import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  invPurchaseOrders,
  invPoLines,
  invProductVariants,
  invGrns,
  invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { UomConversionService } from "../stock-engine/uom-conversion.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { addDec, mulDec } from "../stock-engine/stock-engine.service";
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
    private readonly warehouseScope: WarehouseScopeService,
    private readonly uom: UomConversionService,
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
    // RBAC DataScope answers "whose records", warehouse scope answers "which
    // sites" — separate checks, and both belong in the cache key or one
    // caller's warehouses are served to the next.
    const warehouses = userId
      ? await this.warehouseScope.forUser(orgId, userId)
      : null;
    const hash = `${warehouses?.key ?? "all"}:${status ?? ""}:${vendorId ?? ""}:${limit}:${offset}${scopeSuffix}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invPoNamespace(orgId), hash, async () => {
      const conditions = [eq(invPurchaseOrders.orgId, orgId)];
      if (status) conditions.push(eq(invPurchaseOrders.status, status));
      if (vendorId) conditions.push(eq(invPurchaseOrders.vendorId, vendorId));
      if (scope !== "all" && userId) {
        conditions.push(applyScope(scope, orgId, userId, { ownerColumn: invPurchaseOrders.createdBy }));
      }
      if (warehouses) conditions.push(warehouses.warehouse(sql`${invPurchaseOrders.warehouseId}`));
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

  async getPo(orgId: string, poId: number, userId?: string) {
    const warehouses = userId ? await this.warehouseScope.forUser(orgId, userId) : null;
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(
        eq(invPurchaseOrders.id, poId),
        eq(invPurchaseOrders.orgId, orgId),
        // Out of scope reads as absent, never as forbidden: a 403 on an id the
        // caller may not see confirms the record exists.
        ...(warehouses ? [warehouses.warehouse(sql`${invPurchaseOrders.warehouseId}`)] : []),
      ),
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

    await this.db.insert(invPoLines).values(await this.resolveLines(orgId, po.id, data.lines));

    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return po;
  }

  /**
   * Turns entered quantities into base quantities, carrying the factor.
   *
   * The line keeps what was typed, the unit it was typed in and the factor
   * applied, so a later correction to the conversion cannot rewrite what this
   * order meant. `quantity` is always base UOM, because that is the only unit
   * the ledger can add up across products.
   */
  private async resolveLines(
    orgId: string,
    poId: number,
    lines: CreatePoInput["lines"],
  ) {
    return Promise.all(
      lines.map(async (line) => {
        const variant = await this.db.query.invProductVariants.findFirst({
          where: and(eq(invProductVariants.id, line.productVariantId), eq(invProductVariants.orgId, orgId)),
          columns: { productId: true },
        });
        if (!variant) throw new BadRequestException("Product variant not found");

        const converted = await this.uom.convert(orgId, variant.productId, line.uomId ?? null, String(line.quantity));
        return {
          orgId,
          poId,
          productVariantId: line.productVariantId,
          quantity: converted.quantity,
          quantityEntered: converted.quantityEntered,
          uomId: converted.uomId,
          uomFactor: converted.uomFactor,
          unitCost: line.unitCost,
          taxRate: line.taxRate,
          // Priced per entered unit, so the amount follows the entered quantity,
          // not the converted one — a case costs a case price.
          amount: mulDec(String(line.quantity), line.unitCost),
          lineOrder: line.lineOrder,
        };
      }),
    );
  }

  async updatePo(orgId: string, poId: number, userId: string, data: UpdatePoInput) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, po.warehouseId);
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

      // Scoped by tenant as well as document: a delete keyed on poId alone leans
      // entirely on RLS for tenant correctness, where an explicit predicate belongs.
      await this.db.delete(invPoLines).where(and(eq(invPoLines.poId, poId), eq(invPoLines.orgId, orgId)));
      await this.db.insert(invPoLines).values(await this.resolveLines(orgId, poId, data.lines));
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
    const settings = await this.settingsService.get(orgId);
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, po.warehouseId);
    if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be approved");

    if (!settings.requirePoApproval) {
      throw new BadRequestException(
        "Purchase order approval is not required for this organisation; send the PO directly",
      );
    }

    const [updated] = await this.db.update(invPurchaseOrders)
      .set({
        status: "SENT",
        approvedBy: userId,
        approvedAt: new Date(),
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return updated;
  }

  async sendPo(orgId: string, poId: number, userId: string) {
    const settings = await this.settingsService.get(orgId);
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, po.warehouseId);
    if (po.status !== "DRAFT") throw new BadRequestException("Only DRAFT purchase orders can be sent");

    if (settings.requirePoApproval && !po.approvedBy) {
      throw new BadRequestException("This purchase order requires approval before sending");
    }

    const [sent] = await this.db.update(invPurchaseOrders)
      .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return sent;
  }

  async closePo(orgId: string, poId: number, userId: string) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, po.warehouseId);
    if (po.status !== "RECEIVED" && po.status !== "PARTIAL") {
      throw new BadRequestException("Only RECEIVED or PARTIAL purchase orders can be closed");
    }

    const [closed] = await this.db.update(invPurchaseOrders)
      .set({ status: "CLOSED", updatedAt: new Date() })
      .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return closed;
  }

  async cancelPo(orgId: string, poId: number, userId: string) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, po.warehouseId);
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
      .where(and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return cancelled;
  }
}
