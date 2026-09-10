import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invProducts,
  invProductVariants,
  invProductUomConversions,
  invStockLevels,
  invUom,
  invVendors,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { assertCaptureRulesCoherent, assertUnitConvertible, PACKED_WHOLE } from "./quantity-capture";
import {
  PRODUCT_TAX_FIELD_KEYS,
  PRODUCT_PHARMACY_FIELD_KEYS,
  PRODUCT_KIRANA_FIELD_KEYS,
  PRODUCT_MATERIALS_FIELD_KEYS,
} from "../dto/inv-products.schemas";
import type { CreateProductInput, UpdateProductInput } from "../dto/inv-products.schemas";

/**
 * What a product write must be true of before it happens.
 *
 * Grouped because they share one property: every one of them throws or does
 * nothing, and none of them writes. `createProduct` and `updateProduct` each
 * call four of the six, in the same order, and reading them together is how you
 * see that the two paths agree.
 */
export interface ProductAssertionDeps {
  readonly db: Db;
  readonly settings: InventorySettingsService;
}

/**
 * E1 — the pack flag, doing something.
 *
 * With the `gst` pack off there is no HSN field on the form, no HSN column in
 * the response, and no way to write one through the API either. A gate that
 * only hides the field leaves the column writable by anyone who has read the
 * network tab, and then the organisation has classification data it cannot see
 * or correct.
 */
export async function assertPacksForFields(
  deps: ProductAssertionDeps,
  orgId: string,
  data: CreateProductInput | UpdateProductInput,
): Promise<void> {
  const gates = [
    { keys: PRODUCT_TAX_FIELD_KEYS, on: "gst", code: "GST_PACK_DISABLED", label: "GST" },
    { keys: PRODUCT_PHARMACY_FIELD_KEYS, on: "pharmacy", code: "PHARMACY_PACK_DISABLED", label: "pharmacy" },
    { keys: PRODUCT_KIRANA_FIELD_KEYS, on: "kirana", code: "KIRANA_PACK_DISABLED", label: "kirana" },
    { keys: PRODUCT_MATERIALS_FIELD_KEYS, on: "materials", code: "MATERIALS_PACK_DISABLED", label: "materials" },
  ] as const;
  const touched = gates
    .map((gate) => ({ gate, supplied: gate.keys.filter((key) => key in data) }))
    .filter(({ supplied }) => supplied.length > 0);
  if (touched.length === 0) return;

  const settings = await deps.settings.get(orgId);
  for (const { gate, supplied } of touched) {
    if (settings.packs[gate.on]) continue;
    throw new BadRequestException({
      code: gate.code,
      message: `The ${gate.label} pack is not enabled for this organisation, so ${supplied.join(", ")} cannot be set. Enable it in inventory settings first.`,
    });
  }
}

/**
 * E4. The entry contract has to stay coherent whichever half of it the patch
 * touched — a request that sets `saleMode: "LOOSE"` and nothing else has to be
 * checked against the modes already stored, not against its own two keys.
 */
export async function assertCaptureConfig(
  deps: ProductAssertionDeps,
  orgId: string,
  productId: number | null,
  data: CreateProductInput | UpdateProductInput,
): Promise<void> {
  const touched = PRODUCT_KIRANA_FIELD_KEYS.some((key) => key in data);
  if (!touched) return;

  const stored = productId
    ? await deps.db.query.invProducts.findFirst({
        where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
        columns: {
          saleMode: true, quantityInputMode: true, quantityPrecision: true,
          uomId: true, salesUomId: true,
        },
      })
    : null;

  const saleMode = data.saleMode ?? stored?.saleMode ?? PACKED_WHOLE.saleMode;
  assertCaptureRulesCoherent({
    saleMode,
    inputMode: data.quantityInputMode ?? stored?.quantityInputMode ?? PACKED_WHOLE.inputMode,
    precision: data.quantityPrecision ?? stored?.quantityPrecision ?? PACKED_WHOLE.precision,
  });

  // A loose SKU that sells in a unit other than the one it is stocked in needs
  // the factor between them, or every sale of 500 g removes 500 kg. Checked
  // before the write, against the state the patch would leave behind — and only
  // where the product already exists, because a product and its conversion rows
  // cannot be written in one request.
  if (saleMode !== "LOOSE" || !productId) return;
  const uomId = data.uomId ?? stored?.uomId ?? null;
  const salesUomId = data.salesUomId ?? stored?.salesUomId ?? null;
  if (salesUomId === null || salesUomId === uomId) return;

  const [unit, conversion] = await Promise.all([
    deps.db.query.invUom.findFirst({
      where: and(eq(invUom.id, salesUomId), eq(invUom.orgId, orgId)),
      columns: { abbreviation: true },
    }),
    deps.db.query.invProductUomConversions.findFirst({
      where: and(
        eq(invProductUomConversions.orgId, orgId),
        eq(invProductUomConversions.productId, productId),
        eq(invProductUomConversions.uomId, salesUomId),
      ),
      columns: { uomId: true },
    }),
  ]);
  assertUnitConvertible(unit?.abbreviation ?? `unit ${salesUomId}`, "salesUomId", Boolean(conversion));
}

export async function assertNoStockForVariants(
  deps: ProductAssertionDeps,
  orgId: string,
  productId: number,
  errorCode: string,
  message: string,
): Promise<void> {
  const variants = await deps.db.query.invProductVariants.findMany({
    where: and(
      eq(invProductVariants.productId, productId),
      eq(invProductVariants.orgId, orgId),
    ),
    columns: { id: true },
  });
  if (variants.length === 0) return;
  const variantIds = variants.map((v) => v.id);
  const [result] = await deps.db
    .select({
      total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')`,
    })
    .from(invStockLevels)
    .where(inArray(invStockLevels.productVariantId, variantIds));
  if (parseFloat(result?.total ?? "0") > 0) {
    throw new BadRequestException({ message, code: errorCode });
  }
}

export async function assertUomBelongsToOrg(
  deps: ProductAssertionDeps,
  orgId: string,
  uomId: number,
  fieldName: string,
): Promise<void> {
  const uom = await deps.db.query.invUom.findFirst({
    where: and(eq(invUom.id, uomId), eq(invUom.orgId, orgId)),
    columns: { id: true },
  });
  if (!uom)
    throw new BadRequestException(
      `${fieldName} refers to a UOM not found in this organisation`,
    );
}

export async function assertVendorBelongsToOrg(
  deps: ProductAssertionDeps,
  orgId: string,
  vendorId: number,
): Promise<void> {
  const vendor = await deps.db.query.invVendors.findFirst({
    where: and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)),
    columns: { id: true },
  });
  if (!vendor)
    throw new BadRequestException(
      "defaultVendorId refers to a vendor not found in this organisation",
    );
}
