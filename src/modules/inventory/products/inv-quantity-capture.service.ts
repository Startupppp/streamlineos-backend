import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { invProductUomConversions, invProducts, invProductVariants, invUom } from "../../../db/schema";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { UomConversionService, type ConvertedQuantity } from "../stock-engine/uom-conversion.service";
import {
  assertEnteredQuantity as assertQuantityWithinRules,
  assertUnitConvertible,
  PACKED_WHOLE,
  type QuantityCaptureRules,
} from "./lib/quantity-capture";
import type { QuantityCaptureQuery } from "./dto/inv-products.schemas";

interface UomRef {
  id: number;
  name: string;
  abbreviation: string;
}

/**
 * E4 — the kirana pack's answer to "what may a quantity for this SKU look like,
 * and what does the line record".
 *
 * Two halves that have to stay together. The rules half decides whether 2.995 is
 * a quantity at all for this product; the conversion half turns it into what the
 * ledger holds. Split across two callers they drift: a receiving screen that
 * validates but does not convert writes 2.995 kilograms into a gram ledger, and
 * one that converts but does not validate writes a scale's fourth digit into a
 * SKU sold in whole tins.
 *
 * The conversion is not reimplemented here. `UomConversionService` already does
 * it in BigInt and already snapshots `uomFactor` onto the line — the bug B1
 * fixed, where a delivery counted in cases reached the ledger as that many
 * singles, is exactly what that snapshot exists to prevent.
 */
@Injectable()
export class InvQuantityCaptureService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: InventorySettingsService,
    private readonly uom: UomConversionService,
  ) {}

  async packEnabled(orgId: string): Promise<boolean> {
    const settings = await this.settings.get(orgId);
    return settings.packs.kirana;
  }

  /**
   * The entry contract for one SKU, and — when the caller supplies a quantity —
   * exactly what a document line would record for it.
   *
   * With the pack off `rules` is null and nothing about entry is constrained:
   * that is the whole meaning of the flag, and a distributor typing 2.5 pallets
   * must not meet a validation rule nobody asked for. The conversion still
   * answers, because converting a unit is not a kirana idea — it predates the
   * pack and every organisation with a case size needs it.
   */
  async captureContract(
    orgId: string,
    productVariantId: number,
    query: QuantityCaptureQuery,
  ): Promise<{
    packEnabled: boolean;
    productId: number;
    rules: QuantityCaptureRules | null;
    stockUom: UomRef | null;
    purchaseUom: UomRef | null;
    salesUom: UomRef | null;
    conversions: Array<{ uomId: number; abbreviation: string; factorToBase: string }>;
    snapshot: ConvertedQuantity | null;
  }> {
    const enabled = await this.packEnabled(orgId);
    const product = await this.loadProduct(orgId, productVariantId);
    const rules = enabled ? product.rules : null;

    const [units, conversions] = await Promise.all([
      this.loadUnits(orgId, [product.uomId, product.purchaseUomId, product.salesUomId]),
      this.loadConversions(orgId, product.productId),
    ]);

    let snapshot: ConvertedQuantity | null = null;
    if (query.quantity !== undefined) {
      // Validated before conversion, deliberately. Converting first would turn a
      // rejected 2.9955 kg into an accepted 2995.5 g and hide the refusal behind
      // a unit change.
      if (rules) assertQuantityWithinRules(rules, query.quantity);
      snapshot = await this.uom.convert(
        orgId,
        product.productId,
        query.uomId ?? null,
        query.quantity,
      );
    }

    const unit = (id: number | null) => (id === null ? null : units.get(id) ?? null);
    return {
      packEnabled: enabled,
      productId: product.productId,
      rules,
      stockUom: unit(product.uomId),
      purchaseUom: unit(product.purchaseUomId),
      salesUom: unit(product.salesUomId),
      conversions,
      snapshot,
    };
  }

  /**
   * The entry gate, for the modules that write document lines to call.
   *
   * A no-op while the pack is off, which is what makes the flag real rather than
   * cosmetic: turning it off removes the rule, it does not merely hide a field.
   */
  async assertEnteredQuantity(
    orgId: string,
    productVariantId: number,
    quantity: string,
  ): Promise<void> {
    if (!(await this.packEnabled(orgId))) return;
    const product = await this.loadProduct(orgId, productVariantId);
    assertQuantityWithinRules(product.rules, quantity);
  }

  /**
   * Refuses a purchase or sales unit that cannot be converted to the stock unit.
   *
   * Called on update rather than create: a product and its conversion rows
   * cannot be written in one request, so on create there is nothing that could
   * satisfy this yet. A unit configured on create and never given a factor is
   * still refused, loudly, by `UomConversionService.factorFor` the first time a
   * document tries to use it.
   */
  async assertProductUnitsConvertible(orgId: string, productId: number): Promise<void> {
    const product = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { uomId: true, purchaseUomId: true, salesUomId: true },
    });
    if (!product) return;

    const needed = [
      { id: product.purchaseUomId, field: "purchaseUomId" },
      { id: product.salesUomId, field: "salesUomId" },
    ].filter((u): u is { id: number; field: string } => u.id !== null && u.id !== product.uomId);
    if (needed.length === 0) return;

    const [units, conversions] = await Promise.all([
      this.loadUnits(orgId, needed.map((u) => u.id)),
      this.loadConversions(orgId, productId),
    ]);
    const converted = new Set(conversions.map((c) => c.uomId));
    for (const unit of needed) {
      assertUnitConvertible(
        units.get(unit.id)?.abbreviation ?? `unit ${unit.id}`,
        unit.field,
        converted.has(unit.id),
      );
    }
  }

  private async loadProduct(orgId: string, productVariantId: number): Promise<{
    productId: number;
    uomId: number | null;
    purchaseUomId: number | null;
    salesUomId: number | null;
    rules: QuantityCaptureRules;
  }> {
    const [row] = await this.db
      .select({
        productId: invProducts.id,
        uomId: invProducts.uomId,
        purchaseUomId: invProducts.purchaseUomId,
        salesUomId: invProducts.salesUomId,
        saleMode: invProducts.saleMode,
        quantityInputMode: invProducts.quantityInputMode,
        quantityPrecision: invProducts.quantityPrecision,
      })
      .from(invProductVariants)
      .innerJoin(
        invProducts,
        and(eq(invProducts.id, invProductVariants.productId), eq(invProducts.orgId, orgId)),
      )
      .where(
        and(
          eq(invProductVariants.id, productVariantId),
          eq(invProductVariants.orgId, orgId),
          isNull(invProductVariants.deletedAt),
        ),
      );

    // Re-asserted against orgId above, so another tenant's variant resolves to
    // nothing and surfaces as 404 rather than 403.
    if (!row) throw new NotFoundException("Product variant not found");
    return {
      productId: row.productId,
      uomId: row.uomId,
      purchaseUomId: row.purchaseUomId,
      salesUomId: row.salesUomId,
      rules: {
        saleMode: row.saleMode ?? PACKED_WHOLE.saleMode,
        inputMode: row.quantityInputMode ?? PACKED_WHOLE.inputMode,
        precision: row.quantityPrecision ?? PACKED_WHOLE.precision,
      },
    };
  }

  private async loadUnits(orgId: string, ids: Array<number | null>): Promise<Map<number, UomRef>> {
    const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.db
      .select({ id: invUom.id, name: invUom.name, abbreviation: invUom.abbreviation })
      .from(invUom)
      .where(and(eq(invUom.orgId, orgId), inArray(invUom.id, wanted)));
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async loadConversions(orgId: string, productId: number) {
    return this.db
      .select({
        uomId: invProductUomConversions.uomId,
        abbreviation: invUom.abbreviation,
        factorToBase: invProductUomConversions.factorToBase,
      })
      .from(invProductUomConversions)
      .innerJoin(
        invUom,
        and(eq(invUom.id, invProductUomConversions.uomId), eq(invUom.orgId, orgId)),
      )
      .where(
        and(
          eq(invProductUomConversions.orgId, orgId),
          eq(invProductUomConversions.productId, productId),
        ),
      )
      .orderBy(asc(invUom.abbreviation));
  }
}
