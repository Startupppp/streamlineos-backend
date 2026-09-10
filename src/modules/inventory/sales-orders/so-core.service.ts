import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  invSalesOrders,
  invSoLines,
  invStockLevels,
  businessParties,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { InvNearExpiryPolicy } from "../stock-engine/stock-engine.types";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { SoLifecycleService } from "./so-lifecycle.service";
import { addDec, mulDec } from "../stock-engine/stock-engine.service";
import { loadOrderableVariants, type OrderableVariant } from "../products/lib/orderable-variants";
import { assertCatchWeightLine } from "../stock-types/catch-weight";
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

/**
 * NEO-10 — the order line as it is stored, with the catch-weight rule applied.
 *
 * A catch-weight SKU is sold by weight and handled in pieces. `quantity` is the
 * weight and `amount` is `unitPrice x weight` — which is what the arithmetic
 * above already did, because for this kind of SKU the ledger quantity *is* the
 * weight. What was missing is the other half of the fact: how many bags.
 *
 * The receipt side has refused a catch-weight line with no piece count since
 * NEO-10 was built (`grn.service.ts`); the sales side accepted one, and then
 * dropped the field on the floor even when a caller sent it. So an order could
 * be raised for 5.10 kg of chicken with nothing telling the picker whether that
 * was one bag or four, and `inv_so_lines.quantity_pieces` was a column nothing
 * ever wrote. Both halves are fixed here: the rule is asserted, and the answer
 * is stored.
 */
function toSoLineValues(
  orgId: string,
  soId: number,
  line: {
    productVariantId: number;
    quantity: number;
    quantityPieces?: number;
    unitPrice: string;
    taxRate: string;
    lineOrder: number;
  },
  variants: Map<number, OrderableVariant>,
) {
  const quantity = line.quantity.toFixed(4);
  const quantityPieces = line.quantityPieces === undefined ? null : line.quantityPieces.toFixed(4);
  assertCatchWeightLine(variants.get(line.productVariantId)?.measureMode ?? "PIECES", {
    quantity,
    quantityPieces,
  });

  return {
    orgId,
    soId,
    productVariantId: line.productVariantId,
    quantity: line.quantity.toString(),
    quantityPieces,
    unitPrice: line.unitPrice,
    taxRate: line.taxRate,
    amount: mulDec(quantity, line.unitPrice),
    costAtTime: variants.get(line.productVariantId)?.costPrice ?? "0",
    lineOrder: line.lineOrder,
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

  /**
   * Which sales orders this caller may see — the list's rule, now the only copy.
   *
   * An order names its warehouse on the row, so this is the plain column
   * predicate. The NULL half is worth stating because it differs by table on
   * purpose: `warehouse_id` is nullable and `NULL IN (…)` is NULL, so an order
   * attributed to no building is INVISIBLE to a scoped caller — exactly what the
   * list has always done. That is the opposite of the ASN header, which keeps an
   * `IS NULL` escape because its warehouse may genuinely not be known yet, and
   * of the handling unit, which is built before it is put anywhere. Each detail
   * follows its own aggregate, and this one follows the list above it.
   *
   * Private and single so the detail and the edit cannot drift from the list.
   */
  private soInScope(scope: ResolvedWarehouseScope): SQL {
    return scope.warehouse(sql`${invSalesOrders.warehouseId}`);
  }

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
        if (warehouses) conditions.push(this.soInScope(warehouses));
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
  async getSo(orgId: string, userId: string, soId: number) {
    /*
     * `listSos` beside this has narrowed on the caller's warehouses since the
     * warehouse work landed; this took no `userId` at all, because the
     * controller had `@CurrentUser()` in hand and passed only `orgId`. So an
     * order an operator could not see in their list was theirs to read whole:
     * the customer, the shipping address, every line with its price, and the
     * invoice hanging off it.
     *
     * Nothing downstream would have caught it — a read posts no movements, so
     * the engine's `assertLocationsInScope` never runs on this path.
     *
     * The `/:soId/atp` route reads through here first and spends the lines it
     * gets on `getAtp`, so gating this gates that too: availability stays the
     * org-wide number a promise is actually made against, but you can only ask
     * it about an order you may see.
     *
     * Not cached. `CACHE_KEYS.invSoDetail` exists and five services bust it, but
     * nothing has ever read it — so there is no key here to carry a scope
     * discriminator. If one is ever added it must carry `scope.key`, or a
     * correct predicate under a scope-free key would store one caller's narrowed
     * answer and serve it to the next, which is worse than the unscoped read
     * this replaces (§6).
     */
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(
        eq(invSalesOrders.id, soId),
        eq(invSalesOrders.orgId, orgId),
        this.soInScope(scope),
      ),
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
    /*
     * A sales order ships OUT of a warehouse, so the rule is a transfer's source
     * rule: only out of a building you hold. `data.warehouseId` came straight off
     * the request body and was written unchecked, and nothing downstream catches
     * it — creating an order posts no movements, so the stock engine's
     * `assertLocationsInScope` never runs on this path, and `listSos` then hides
     * the row from the very person who raised it while it stands as demand on
     * somebody else's shelves.
     *
     * Only asserted when one is given: `inv_sales_orders.warehouse_id` is
     * nullable and an order with no warehouse yet is a legitimate draft, not an
     * attempt at somebody else's building. 404 rather than 403, so naming a
     * warehouse you cannot see does not confirm it exists.
     *
     * First, ahead of `numSeq.next`: a refused order should not burn an order
     * number, and a caller who may not see the warehouse should not move the
     * organisation's SO sequence on.
     */
    if (data.warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);
    }

    const soNumber = await this.numSeq.next(orgId, "SO");
    const { subtotal, taxAmount, total } = computeSoTotals(data.lines);

    // INV-107. This looked variants up by id alone -- no tenant predicate and
    // no lifecycle check -- so another organisation's variant resolved to a row
    // and a discontinued SKU was as orderable as a live one.
    const variantIds = data.lines.map((l) => l.productVariantId);
    const orderable = await loadOrderableVariants(this.db, orgId, variantIds);

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
          channelId: data.channelId ?? null,
          platformPoId: data.platformPoId ?? null,
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
        data.lines.map((line) => toSoLineValues(orgId, header.id, line, orderable)),
      );

      return header;
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return so;
  }

  async updateSo(orgId: string, soId: number, userId: string, data: UpdateSoInput) {
    /*
     * The same gate `createSo` now carries, on the other way in. Editing a draft
     * was a way to move an order into a building the caller holds nothing in,
     * which `createSo` refuses — and the write here is an `UPDATE ... SET
     * warehouse_id` with no movements behind it, so nothing downstream looks.
     *
     * This method took no `userId` at all until now: the controller had one and
     * never passed it, which is why the hole could not have been closed here
     * without threading it through.
     *
     * `undefined` means "leave the warehouse alone" and is not asked about; the
     * column is nullable and only a value the caller actually supplied is theirs
     * to justify. First, ahead of the order lookup, so a caller naming a
     * warehouse they cannot see causes no query about the order and cannot read
     * the refusal's shape to learn whether it exists or is still a draft.
     */
    if (data.warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);
    }

    /*
     * And the order's OWN warehouse, which is the half this method was still
     * missing. The destination gate above answers "may you move it THERE"; it
     * says nothing about whether you may touch the order at all, so a caller
     * holding one building could still edit any DRAFT order in the organisation
     * — its client, its lines, its quantities, its prices — provided they did
     * not also try to re-home it. Same predicate as the list, so a draft you can
     * edit is exactly a draft you could have found.
     *
     * Ahead of the status check, so a refusal cannot report whether the order
     * exists or is still a draft.
     */
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(
        eq(invSalesOrders.id, soId),
        eq(invSalesOrders.orgId, orgId),
        this.soInScope(scope),
      ),
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
    if (data.channelId !== undefined) patch.channelId = data.channelId;
    if (data.platformPoId !== undefined) patch.platformPoId = data.platformPoId;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.notes !== undefined) patch.notes = data.notes;

    let orderable = new Map<number, OrderableVariant>();
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
      orderable = await loadOrderableVariants(this.db, orgId, variantIds);
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
          (data.lines ?? []).map((line) => toSoLineValues(orgId, soId, line, orderable)),
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
    return this.getSo(orgId, userId, soId);
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
    /**
     * D2. Forwarded rather than dropped. This delegation used to stop at
     * `expiryPolicy`, so every caller reaching the allocator through here — the
     * reserve button, pick waves, pick substitution — allocated with no
     * near-expiry tier and no customer shelf-life floor, whatever the
     * organisation and the contract said. A parameter silently not forwarded is
     * the same defect as a rule not written.
     */
    constraints?: {
      nearExpiryPolicy: InvNearExpiryPolicy;
      nearExpiryWindowDays: number;
      minShelfLifeDays: number;
    },
  ) {
    return this.lifecycle.findAvailableLotForLine(
      orgId,
      variantId,
      warehouseId,
      qty,
      strategy,
      expiryPolicy,
      constraints,
    );
  }
}
