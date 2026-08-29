import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  invSalesOrders,
  invSoLines,
  invStockLevels,
  businessParties,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { SoLifecycleService } from "./so-lifecycle.service";
import { addDec, mulDec } from "../stock-engine/stock-engine.service";
import { loadOrderableVariants } from "../products/lib/orderable-variants";
import { availableQty } from "../stock-engine/decimal";
import type {
  CreateSoInput,
  ListSoInput,
  UpdateSoInput,
} from "./dto/inv-sales-orders.schemas";

function computeSoTotals(
  lines: Array<{ quantity: number; unitPrice: string; taxRate: string }>,
) {
  let subtotal = "0";
  let taxAmount = "0";
  for (const l of lines) {
    const lineAmt = mulDec(l.quantity.toFixed(4), l.unitPrice);
    subtotal = addDec(subtotal, lineAmt);
    taxAmount = addDec(
      taxAmount,
      mulDec(lineAmt, (parseFloat(l.taxRate) / 100).toFixed(10)),
    );
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
    private readonly lifecycle: SoLifecycleService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listSos(
    orgId: string,
    filters: ListSoInput,
    scope: DataScope = "all",
    userId?: string,
  ) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, clientId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    const warehouses = userId ? await this.warehouseScope.forUser(orgId, userId) : null;
    const hash = `${warehouses?.key ?? "all"}:${status ?? ""}:${clientId ?? ""}:${limit}:${offset}${scopeSuffix}`;

    return this.cache.cachedVersioned(
      CACHE_KEYS.invSoNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invSalesOrders.orgId, orgId)];
        if (warehouses) conditions.push(warehouses.warehouse(sql`${invSalesOrders.warehouseId}`));
        if (status) conditions.push(eq(invSalesOrders.status, status));
        if (clientId) conditions.push(eq(invSalesOrders.clientId, clientId));
        if (scope !== "all" && userId) {
          conditions.push(
            applyScope(scope, orgId, userId, {
              ownerColumn: invSalesOrders.createdBy,
            }),
          );
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
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invSalesOrders)
            .where(where),
        ]);

        return {
          items,
          total: countResult[0]?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * A sales order with everything the detail screen shows.
   *
   * The customer is resolved through Party, not by joining `clients`. That table
   * was dropped by the identity migration during this work, so the eager join
   * here failed outright with `42P01 relation "clients" does not exist` — every
   * read of a sales order, including the one the fulfilment flow makes after
   * shipping. `inv_sales_orders.client_party_id` is the Party-era column and
   * carries the same customer.
   */
  async getSo(orgId: string, soId: number) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: {
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
    return { ...so, client: await this.resolveCustomer(orgId, so.clientPartyId) };
  }

  /** Display identity only; anything sensitive stays behind its own gate. */
  private async resolveCustomer(orgId: string, partyId: string | null) {
    if (!partyId) return null;
    const [party] = await this.db
      .select({
        partyId: businessParties.partyId,
        displayName: businessParties.displayName,
        companyName: businessParties.companyName,
      })
      .from(businessParties)
      .where(and(eq(businessParties.organizationId, orgId), eq(businessParties.partyId, partyId)))
      .limit(1);
    return party ?? null;
  }

  async createSo(orgId: string, userId: string, data: CreateSoInput) {
    const soNumber = await this.numSeq.next(orgId, "SO");
    const { subtotal, taxAmount, total } = computeSoTotals(data.lines);

    // INV-107. This looked variants up by id alone -- no tenant predicate and
    // no lifecycle check -- so another organisation's variant resolved to a row
    // and a discontinued SKU was as orderable as a live one.
    const variantIds = data.lines.map((l) => l.productVariantId);
    const orderable = await loadOrderableVariants(this.db, orgId, variantIds);
    const variantCostMap = new Map(
      [...orderable.values()].map((v) => [v.id, v.costPrice]),
    );

    const so = await this.db.transaction(async (tx) => {
      const [header] = await (tx as Db)
        .insert(invSalesOrders)
        .values({
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
        })
        .returning();

      await (tx as Db).insert(invSoLines).values(
        data.lines.map((line) => ({
          orgId,
          soId: header.id,
          productVariantId: line.productVariantId,
          quantity: line.quantity.toString(),
          unitPrice: line.unitPrice,
          taxRate: line.taxRate,
          amount: mulDec(line.quantity.toFixed(4), line.unitPrice),
          costAtTime: variantCostMap.get(line.productVariantId) ?? "0",
          lineOrder: line.lineOrder,
        })),
      );

      return header;
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return so;
  }

  async updateSo(orgId: string, soId: number, data: UpdateSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "DRAFT")
      throw new BadRequestException("Only DRAFT sales orders can be updated");

    const patch: Partial<typeof invSalesOrders.$inferInsert> = {};
    if (data.clientId !== undefined) patch.clientId = data.clientId;
    if (data.orderDate !== undefined) patch.orderDate = data.orderDate;
    if (data.requiredDate !== undefined) patch.requiredDate = data.requiredDate;
    if (data.shippingAddress !== undefined)
      patch.shippingAddress = data.shippingAddress;
    if (data.warehouseId !== undefined) patch.warehouseId = data.warehouseId;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.notes !== undefined) patch.notes = data.notes;

    let variantCostMap = new Map<number, string>();
    if (data.lines) {
      const { subtotal, taxAmount, total } = computeSoTotals(data.lines);
      patch.subtotal = subtotal;
      patch.taxAmount = taxAmount;
      patch.total = total;

      // INV-107. The same gate createSo carries. This lookup was left behind
      // when that one was fixed: no tenant predicate and no lifecycle check, so
      // editing a draft order was a way to put another organisation's variant --
      // or a discontinued one -- onto a line that creating the order refuses.
      const variantIds = data.lines.map((l) => l.productVariantId);
      const orderable = await loadOrderableVariants(this.db, orgId, variantIds);
      variantCostMap = new Map(
        [...orderable.values()].map((v) => [v.id, v.costPrice]),
      );
    }

    await this.db.transaction(async (tx) => {
      if (data.lines) {
        // Tenant predicate on the delete too: leaning on RLS alone is exactly
        // what made the lookup above dangerous, and RLS is inert under the
        // owner role.
        await (tx as Db)
          .delete(invSoLines)
          .where(and(eq(invSoLines.orgId, orgId), eq(invSoLines.soId, soId)));

        await (tx as Db).insert(invSoLines).values(
          (data.lines ?? []).map((line) => ({
            orgId,
            soId,
            productVariantId: line.productVariantId,
            quantity: line.quantity.toString(),
            unitPrice: line.unitPrice,
            taxRate: line.taxRate,
            amount: mulDec(line.quantity.toFixed(4), line.unitPrice),
            costAtTime: variantCostMap.get(line.productVariantId) ?? "0",
            lineOrder: line.lineOrder,
          })),
        );
      }

      if (Object.keys(patch).length > 0) {
        await (tx as Db)
          .update(invSalesOrders)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
          );
      }
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return this.getSo(orgId, soId);
  }

  async getAtp(orgId: string, productVariantIds: number[]) {
    if (productVariantIds.length === 0) return [];

    const levels = await this.db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, productVariantIds),
      ),
      columns: {
        productVariantId: true,
        onHand: true,
        committed: true,
        onOrder: true,
        blockedQty: true,
        qualityHoldQty: true,
        outgoingQty: true,
      },
      // A2. Availability now depends on where the row stands, not only on its
      // buckets: goods parked at a warehouse's TRANSIT location are on hand and
      // are not for sale. Without this the ATP a sales order quotes would
      // include stock that is physically in a van.
      with: { location: { columns: { isSellable: true } } },
    });

    const grouped = new Map<
      number,
      {
        onHand: number;
        committed: number;
        onOrder: number;
        blocked: number;
        qualityHold: number;
        outgoing: number;
        available: number;
      }
    >();

    for (const l of levels) {
      const existing = grouped.get(l.productVariantId);
      const onHand = parseFloat(l.onHand);
      const committed = parseFloat(l.committed);
      const onOrder = parseFloat(l.onOrder);
      const blocked = parseFloat(l.blockedQty ?? "0");
      const qualityHold = parseFloat(l.qualityHoldQty ?? "0");
      const outgoing = parseFloat(l.outgoingQty ?? "0");
      // A2. Per row, before anything is summed. The subtraction is linear so
      // the total is the same one summing-then-subtracting produced -- except
      // that the location gate can only be applied while the row still knows
      // which location it belongs to.
      const available = Number(
        availableQty({
          on_hand: l.onHand,
          committed: l.committed,
          blocked_qty: l.blockedQty,
          quality_hold_qty: l.qualityHoldQty,
          outgoing_qty: l.outgoingQty,
          is_sellable: l.location?.isSellable ?? null,
        }),
      );

      if (existing) {
        existing.onHand += onHand;
        existing.committed += committed;
        existing.onOrder += onOrder;
        existing.blocked += blocked;
        existing.qualityHold += qualityHold;
        existing.outgoing += outgoing;
        existing.available += available;
      } else {
        grouped.set(l.productVariantId, {
          onHand,
          committed,
          onOrder,
          blocked,
          qualityHold,
          outgoing,
          available,
        });
      }
    }

    return productVariantIds.map((id) => {
      const agg = grouped.get(id);
      const onHand = agg?.onHand ?? 0;
      const committed = agg?.committed ?? 0;
      const blocked = agg?.blocked ?? 0;
      const qualityHold = agg?.qualityHold ?? 0;
      const onOrder = agg?.onOrder ?? 0;
      const outgoing = agg?.outgoing ?? 0;
      return {
        productVariantId: id,
        onHand,
        committed,
        blocked,
        qualityHold,
        onOrder,
        // A1/A2. One formula, applied per stock row above. This copy omitted
        // outgoing_qty, so a line already picked and waiting on the bench was
        // offered to the next order — and `outgoingQty` was reported as
        // `committed`, which is a different bucket entirely.
        available: agg?.available ?? 0,
        incomingQty: onOrder,
        outgoingQty: outgoing,
      };
    });
  }

  confirmSo(orgId: string, soId: number, userId: string, idempotencyKey: string) {
    return this.lifecycle.confirmSo(orgId, soId, userId, idempotencyKey);
  }

  cancelSo(orgId: string, soId: number, userId: string) {
    return this.lifecycle.cancelSo(orgId, soId, userId);
  }

  invoiceSo(orgId: string, soId: number, userId: string) {
    return this.lifecycle.invoiceSo(orgId, soId, userId);
  }

  findAvailableLotForLine(
    orgId: string,
    variantId: number,
    warehouseId: number | null | undefined,
    /** Base UOM, as a decimal string — never a float. */
    qty: string,
    strategy: string,
    expiryPolicy: string,
  ) {
    return this.lifecycle.findAvailableLotForLine(
      orgId,
      variantId,
      warehouseId,
      qty,
      strategy,
      expiryPolicy,
    );
  }
}
