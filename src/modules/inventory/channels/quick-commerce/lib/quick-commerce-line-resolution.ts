import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invBarcodes,
  invProductVariants,
  invProducts,
} from "../../../../../db/schema";
import { type Db } from "../../../../../db/drizzle.module";
import type { ParsedPlatformPo } from "../quick-commerce-inbound";

/**
 * Matching a platform's line to our catalogue, and saying why when it does not.
 *
 * Split from the ingest flow because it is the only part of NEO-2 that is about
 * the CATALOGUE rather than the document: it answers "is this EAN ours", and
 * every failure it returns is a line the operator has to look at. Keeping the
 * verdict shape here with the code that produces it is what makes "a rejected
 * PO with a reason per line" one thing to read.
 */

/** One line's verdict: the variant it resolved to, or why it did not. */
export interface ResolvedLine {
  lineOrder: number;
  providerSku: string | null;
  ean: string | null;
  mrpPaise: number | null;
  packSize: number | null;
  quantityOrdered: string;
  unitCost: string | null;
  productVariantId: number | null;
  validationError: string | null;
}

export interface FieldError {
  lineOrder: number;
  field: string;
  message: string;
}

export interface LineResolutionDeps {
  readonly db: Db;
}

export /**
 * Resolve every line against this organisation's catalogue.
 *
 * EAN first, then the platform's SKU code against our own SKU. A barcode is
 * the identifier both sides agreed on; a SKU string matching is a fallback
 * that works only when the platform was onboarded with our codes.
 *
 * The checks after resolution are the ones a receiving clerk would otherwise
 * discover on the dock: an MRP the SKU requires and the platform omitted, and
 * a case size that disagrees with ours. Both are refusals rather than
 * warnings, because accepting them creates a purchase order whose quantities
 * mean something different to each side.
 */
async function resolveLines(deps: LineResolutionDeps, orgId: string, parsed: ParsedPlatformPo): Promise<ResolvedLine[]> {
  const eans = parsed.lines.map((l) => l.ean).filter((v): v is string => v !== null);
  const skus = parsed.lines.map((l) => l.providerSku).filter((v): v is string => v !== null);

  const byEan = new Map<string, number>();
  if (eans.length > 0) {
    const rows = await deps.db
      .select({ code: invBarcodes.code, variantId: invBarcodes.productVariantId })
      .from(invBarcodes)
      .where(and(eq(invBarcodes.orgId, orgId), inArray(invBarcodes.code, eans)));
    for (const row of rows) {
      if (row.variantId !== null) byEan.set(row.code, row.variantId);
    }
  }

  const bySku = new Map<string, number>();
  // `mrpRequired` lives on the product, so the variant lookup carries its
  // product's flag rather than making the caller ask a second time.
  const variantMrpRequired = new Map<number, boolean>();
  const candidateIds = [...byEan.values()];
  const rows =
    skus.length > 0 || candidateIds.length > 0
      ? await deps.db
          .select({
            id: invProductVariants.id,
            sku: invProductVariants.sku,
            mrpRequired: invProducts.mrpRequired,
          })
          .from(invProductVariants)
          .innerJoin(
            invProducts,
            and(eq(invProducts.orgId, invProductVariants.orgId), eq(invProducts.id, invProductVariants.productId)),
          )
          .where(
            and(
              eq(invProductVariants.orgId, orgId),
              sql`${invProductVariants.deletedAt} IS NULL`,
              skus.length > 0 && candidateIds.length > 0
                ? sql`(${inArray(invProductVariants.sku, skus)} OR ${inArray(invProductVariants.id, candidateIds)})`
                : skus.length > 0
                  ? inArray(invProductVariants.sku, skus)
                  : inArray(invProductVariants.id, candidateIds),
            ),
          )
      : [];
  for (const row of rows) {
    bySku.set(row.sku, row.id);
    variantMrpRequired.set(row.id, row.mrpRequired);
  }

  return parsed.lines.map((line) => {
    const variantId =
      (line.ean ? byEan.get(line.ean) : undefined) ??
      (line.providerSku ? bySku.get(line.providerSku) : undefined) ??
      null;

    let validationError: string | null = null;
    if (variantId === null) {
      validationError = line.ean
        ? `No product in this catalogue carries the barcode ${line.ean}`
        : line.providerSku
          ? `No product in this catalogue has the SKU ${line.providerSku}`
          : "The line names neither a barcode nor a SKU";
    } else if (variantMrpRequired.get(variantId) === true && line.mrpPaise === null) {
      validationError = "This SKU requires a printed MRP and the purchase order states none";
    } else if (line.packSize !== null && line.packSize <= 0) {
      validationError = `Pack size ${line.packSize} is not a positive number of units`;
    }

    return { ...line, productVariantId: variantId, validationError };
  });
}
