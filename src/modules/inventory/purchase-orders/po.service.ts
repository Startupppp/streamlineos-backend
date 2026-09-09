import { Inject, Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
import { StockProjectionService } from "../stock-engine/stock-projection.service";
import { isPositive, subDec } from "../stock-engine/decimal";
import { loadOrderableVariants } from "../products/lib/orderable-variants";

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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    // A4. The lifecycle gate, on buying as well as selling. A discontinued or
    // archived SKU could be purchased freely — the status was checked when a
    // customer ordered one and not when the warehouse ordered more of it, which
    // is how a product nobody may sell keeps arriving on pallets.
    //
    // It also resolves the owning product, which this used to fetch with one
    // query per line.
    const orderable = await loadOrderableVariants(
      this.db,
      orgId,
      lines.map((line) => line.productVariantId),
    );

    return Promise.all(
      lines.map(async (line) => {
        const variant = orderable.get(line.productVariantId);
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

    // A1. `on_order` had no writer at all: it sat at its "0" default while
    // replenishment read it, so a warehouse that had already ordered the
    // shortfall ordered it again the following week. Sending is the moment the
    // goods become expected.
    const [sent] = await this.db.transaction(async (tx) => {
      // The status predicate belongs in the UPDATE, not only in the read above.
      // Two concurrent sends — a double click, or a client retry after a
      // timeout — both read DRAFT, both passed the guard, and both ran
      // `addOnOrder`, so a 500-unit order booked 1000 as inbound. `addOnOrder`
      // clamps at zero only downward, so the over-booking was unbounded, and
      // replenishment then under-ordered that variant every cycle.
      const updated = await tx
        .update(invPurchaseOrders)
        .set({ status: "SENT", sentAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(invPurchaseOrders.id, poId),
          eq(invPurchaseOrders.orgId, orgId),
          eq(invPurchaseOrders.status, "DRAFT"),
        ))
        .returning();

      // Lost the race: another request already sent this order and booked its
      // inbound quantity. Returning what is there is the honest answer to "send
      // this", and it must not book a second time.
      if (updated.length === 0) {
        return this.db.query.invPurchaseOrders.findFirst({
          where: and(eq(invPurchaseOrders.id, poId), eq(invPurchaseOrders.orgId, orgId)),
        }).then((row) => (row ? [row] : []));
      }

      if (po.warehouseId !== null) {
        const lines = await tx
          .select({
            productVariantId: invPoLines.productVariantId,
            quantity: invPoLines.quantity,
            quantityReceived: invPoLines.quantityReceived,
          })
          .from(invPoLines)
          .where(and(eq(invPoLines.orgId, orgId), eq(invPoLines.poId, poId)));

        for (const line of lines) {
          // Outstanding, not ordered: a partially received order re-sent must
          // not book the already-arrived units as still on their way.
          const outstanding = subDec(
            String(line.quantity),
            String(line.quantityReceived),
          );
          if (isPositive(outstanding)) {
            await this.projection.addOnOrder(
              tx,
              orgId,
              line.productVariantId,
              po.warehouseId,
              outstanding,
            );
          }
        }
      }
      return updated;
    });

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return sent;
  }

  /**
   * A1/A2. Take the still-outstanding quantity of a purchase order back out of
   * `on_order`.
   *
   * `sendPo` books the outstanding quantity as expected and a receipt takes the
   * arrived part back out, but the two terminal states did not: a cancelled or
   * closed order left its unreceived remainder booked as inbound forever, and
   * replenishment reading a permanent phantom arrival under-orders that variant
   * every cycle. The reconciliation report names this as `on_order_vs_purchase_orders`
   * drift, which is how it surfaced.
   *
   * Idempotent in effect: `addOnOrder` clamps at zero, and both callers move the
   * order into a terminal status in the same transaction, so it cannot run twice.
   */
  private async releaseOnOrder(
    tx: Tx,
    orgId: string,
    poId: number,
    warehouseId: number | null,
  ): Promise<void> {
    if (warehouseId === null) return;
    const lines = await tx
      .select({
        productVariantId: invPoLines.productVariantId,
        quantity: invPoLines.quantity,
        quantityReceived: invPoLines.quantityReceived,
      })
      .from(invPoLines)
      .where(and(eq(invPoLines.orgId, orgId), eq(invPoLines.poId, poId)));

    for (const line of lines) {
      const outstanding = subDec(
        String(line.quantity),
        String(line.quantityReceived),
      );
      if (!isPositive(outstanding)) continue;
      await this.projection.addOnOrder(
        tx,
        orgId,
        line.productVariantId,
        warehouseId,
        `-${outstanding}`,
      );
    }
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

    const [closed] = await this.db.transaction(async (tx) => {
      // A PARTIAL order closes with a remainder nobody will ever deliver.
      // Conditional, for the same reason as `sendPo`: two concurrent closes
      // would each release the outstanding quantity, taking it out of `on_order`
      // twice.
      const rows = await tx
        .update(invPurchaseOrders)
        .set({ status: "CLOSED", updatedAt: new Date() })
        .where(and(
          eq(invPurchaseOrders.id, poId),
          eq(invPurchaseOrders.orgId, orgId),
          inArray(invPurchaseOrders.status, ["RECEIVED", "PARTIAL"]),
        ))
        .returning();
      if (rows.length === 0) return rows;
      await this.releaseOnOrder(tx, orgId, poId, po.warehouseId);
      return rows;
    });

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

    const [cancelled] = await this.db.transaction(async (tx) => {
      // Only a SENT order ever booked anything; a DRAFT was never expected.
      const rows = await tx
        .update(invPurchaseOrders)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(and(
          eq(invPurchaseOrders.id, poId),
          eq(invPurchaseOrders.orgId, orgId),
          inArray(invPurchaseOrders.status, ["DRAFT", "SENT"]),
        ))
        .returning();
      if (rows.length === 0) return rows;
      // Only a SENT order ever booked anything; a DRAFT was never expected.
      if (po.status === "SENT")
        await this.releaseOnOrder(tx, orgId, poId, po.warehouseId);
      return rows;
    });

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId));
    return cancelled;
  }
}
