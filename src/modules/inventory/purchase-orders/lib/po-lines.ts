import { and, eq } from "drizzle-orm";
import { BadRequestException } from "@nestjs/common";
import { invLocations } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { UomConversionService } from "../../stock-engine/uom-conversion.service";
import { mulDec } from "../../stock-engine/stock-engine.service";
import { loadOrderableVariants } from "../../products/lib/orderable-variants";
import type { CreatePoInput } from "../dto/inv-purchase-orders.schemas";

/**
 * Turning a purchase order's inputs into rows: which location receives it, and
 * what its lines mean in base units. Lifted out of `po.service.ts` unchanged.
 *
 * `resolveLines` was private with no caller outside that service — the two
 * `.resolveLines(` hits elsewhere are quality-recalls and quick-commerce calling
 * their own methods of that name. `resolveLocationId` IS public API, called by
 * grn-receive and grn through the injected service, so the service keeps a
 * delegate for it.
 */
export async function resolveLocationId(
  db: Db,
  orgId: string,
  warehouseId: number | null | undefined,
): Promise<number> {
    if (!warehouseId) throw new BadRequestException("A warehouse is required for this operation");
    const loc = await db.query.invLocations.findFirst({
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

  /**
   * Turns entered quantities into base quantities, carrying the factor.
   *
   * The line keeps what was typed, the unit it was typed in and the factor
   * applied, so a later correction to the conversion cannot rewrite what this
   * order meant. `quantity` is always base UOM, because that is the only unit
   * the ledger can add up across products.
   */
export async function resolveLines(
    db: Db,
    uom: UomConversionService,
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
      db,
      orgId,
      lines.map((line) => line.productVariantId),
    );

    return Promise.all(
      lines.map(async (line) => {
        const variant = orderable.get(line.productVariantId);
        if (!variant) throw new BadRequestException("Product variant not found");

        const converted = await uom.convert(orgId, variant.productId, line.uomId ?? null, String(line.quantity));
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
