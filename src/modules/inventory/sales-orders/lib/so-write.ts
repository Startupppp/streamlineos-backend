import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invSalesOrders, invSoLines } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { addDec, mulDec } from "../../stock-engine/stock-engine.service";
import { loadOrderableVariants, type OrderableVariant } from "../../products/lib/orderable-variants";
import { assertCatchWeightLine } from "../../stock-types/catch-weight";
import type { CreateSoInput, UpdateSoInput } from "../dto/inv-sales-orders.schemas";
import { soInScope } from "./so-scope";

/**
 * The two commands that WRITE a sales order, and the line arithmetic only they
 * use.
 *
 * The seam is the one `SoCoreService`'s own comments keep pointing at: creating
 * and editing an order post no stock movements, so nothing downstream ever looks
 * at them — `assertLocationsInScope` in the engine never runs on either path.
 * Every gate they have they have to carry themselves, and both carry the same
 * two: the destination warehouse must be one the caller holds, and the variants
 * on the lines must be this tenant's and still orderable. That pairing is what
 * makes them one unit, and what makes them different from the reads beside them,
 * which are gated by a predicate rather than by an assertion.
 *
 * Free functions over a deps bag rather than a second `@Injectable`: the DI
 * graph, the constructor and every caller of `SoCoreService` are unchanged, and
 * `updateSalesOrder` deliberately does NOT re-read the order it wrote — the
 * service does that through its own `getSo`, so the scoped detail read stays in
 * one place.
 */
export interface SoWriteDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly numSeq: NumberSequenceService;
  readonly warehouseScope: WarehouseScopeService;
}

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

export async function createSalesOrder(
  deps: SoWriteDeps,
  orgId: string,
  userId: string,
  data: CreateSoInput,
) {
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
    await deps.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);
  }

  const soNumber = await deps.numSeq.next(orgId, "SO");
  const { subtotal, taxAmount, total } = computeSoTotals(data.lines);

  // INV-107. This looked variants up by id alone -- no tenant predicate and
  // no lifecycle check -- so another organisation's variant resolved to a row
  // and a discontinued SKU was as orderable as a live one.
  const variantIds = data.lines.map((l) => l.productVariantId);
  const orderable = await loadOrderableVariants(deps.db, orgId, variantIds);

  const so = await deps.db.transaction(async (tx) => {
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

  await deps.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
  return so;
}

export async function updateSalesOrder(
  deps: SoWriteDeps,
  orgId: string,
  soId: number,
  userId: string,
  data: UpdateSoInput,
): Promise<void> {
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
    await deps.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);
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
  const scope = await deps.warehouseScope.forUser(orgId, userId);
  const so = await deps.db.query.invSalesOrders.findFirst({
    where: and(
      eq(invSalesOrders.id, soId),
      eq(invSalesOrders.orgId, orgId),
      soInScope(scope),
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
    orderable = await loadOrderableVariants(deps.db, orgId, variantIds);
  }

  await deps.db.transaction(async (tx) => {
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

  await deps.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
  await deps.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
}
