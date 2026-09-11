import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { ScopedRead } from "../../access/scoped-read";
import { invPurchaseOrders, invPoLines } from "../../../db/schema";
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
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { resolveLines, resolveLocationId } from "./lib/po-lines";
import {
  approvePo,
  cancelPo,
  closePo,
  sendPo,
  type PoLifecycleDeps,
} from "./lib/po-lifecycle";

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
    private readonly projection: StockProjectionService,
  ) {}

  /**
   * The transitions read through the same collaborators this service is
   * injected with. No second provider, and the constructor is untouched —
   * `po-warehouse-scope.spec.ts` builds this service positionally.
   */
  private get lifecycleDeps(): PoLifecycleDeps {
    return {
      db: this.db,
      cache: this.cache,
      settingsService: this.settingsService,
      warehouseScope: this.warehouseScope,
      projection: this.projection,
    };
  }

  /** @see lib/po-lines.ts — grn-receive and grn call this through the service. */
  async resolveLocationId(orgId: string, warehouseId: number | null | undefined): Promise<number> {
    return resolveLocationId(this.db, orgId, warehouseId);
  }

  async listPos(read: ScopedRead, filters: ListPoInput) {
    const orgId = read.orgId;
    const { status, vendorId, page, limit } = filters;
    const offset = (page - 1) * limit;
    // RBAC scope answers "whose records", warehouse scope answers "which
    // sites" — separate checks, and both belong in the cache key or one
    // caller's warehouses are served to the next.
    const warehouses = await this.warehouseScope.forUser(orgId, read.actorId);
    const hash = `${warehouses?.key ?? "all"}:${status ?? ""}:${vendorId ?? ""}:${limit}:${offset}:${read.discriminator}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invPoNamespace(orgId), hash, () =>
      read.read(
        {
          tenant: invPurchaseOrders.orgId,
          scope: { columns: { ownerColumn: invPurchaseOrders.createdBy } },
          and: [
            status ? eq(invPurchaseOrders.status, status) : undefined,
            vendorId ? eq(invPurchaseOrders.vendorId, vendorId) : undefined,
            warehouses ? warehouses.warehouse(sql`${invPurchaseOrders.warehouseId}`) : undefined,
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
    /*
     * A purchase order is stock arriving INTO a warehouse, and the caller has to
     * hold the building it lands in. `data.warehouseId` came straight off the
     * request body and was written unchecked, and nothing downstream catches it:
     * raising a PO posts no movements, so the stock engine's
     * `assertLocationsInScope` never runs on this path.
     *
     * The asymmetry a transfer draws — assert the source, not the destination —
     * does not apply, and the reason it does not is the whole judgement here. A
     * transfer's far end is spared because an operator moving stock across the
     * estate routinely holds no part of it, so requiring both would refuse every
     * legitimate inter-warehouse move. A purchase order's counterparty is a
     * vendor, outside the scope system entirely; the only warehouse it names is
     * the one it is delivered to, and a scoped operator raising a delivery into
     * a building they hold nothing in has no honest reading. Every other door on
     * this record already agreed: `listPos` and `getPo` filter on the caller's
     * warehouses, and `updatePo`, `approvePo` and `sendPo` each assert the PO's
     * own warehouse. Creation was the one that did not, so a PO could be raised
     * into a warehouse and then be invisible to the person who raised it while
     * standing as expected inbound stock against somebody else's dock.
     *
     * Only asserted when one is given: `inv_purchase_orders.warehouse_id` is
     * nullable and the field is optional, so a PO with no warehouse yet is a
     * legitimate draft rather than an attempt at somebody else's building. 404
     * rather than 403, so naming a warehouse you cannot see does not confirm it
     * exists.
     *
     * Ahead of `numSeq.next`, so a refused order does not burn a PO number out
     * of the organisation's sequence.
     */
    if (data.warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);
    }

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

    await this.db.insert(invPoLines).values(await resolveLines(this.db, this.uom, orgId, po.id, data.lines));

    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return po;
  }


  async updatePo(orgId: string, poId: number, userId: string, data: UpdatePoInput) {
    /*
     * Two different questions, and only one of them was being asked. The assert
     * below covers the PO as it stands — may this caller touch this record — and
     * says nothing about where they are moving it TO. So editing a draft was a
     * way to redirect a delivery into a building the caller holds nothing in,
     * which `createPo` now refuses on the way in.
     *
     * The census could not see this one: it skips any method whose body already
     * mentions `warehouseScope`, and this method's mention is the record gate,
     * not the body gate.
     *
     * First, so a caller naming a warehouse they cannot see causes no query
     * about the purchase order and cannot read the refusal's shape to learn
     * whether it exists or is still a draft. `undefined` means "leave the
     * warehouse alone" and is not asked about.
     */
    if (data.warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);
    }

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
      await this.db.insert(invPoLines).values(await resolveLines(this.db, this.uom, orgId, poId, data.lines));
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

  /**
   * Moving a purchase order through its statuses.
   *
   * @see lib/po-lifecycle.ts — every transition, and why each one is a
   * conditional UPDATE rather than a read-then-write.
   */
  approvePo(orgId: string, poId: number, userId: string) {
    return approvePo(this.lifecycleDeps, orgId, poId, userId);
  }

  sendPo(orgId: string, poId: number, userId: string) {
    return sendPo(this.lifecycleDeps, orgId, poId, userId);
  }

  closePo(orgId: string, poId: number, userId: string) {
    return closePo(this.lifecycleDeps, orgId, poId, userId);
  }

  cancelPo(orgId: string, poId: number, userId: string) {
    return cancelPo(this.lifecycleDeps, orgId, poId, userId);
  }
}
