import { ConflictException } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { invProducts, invProductVariants } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

export async function assertNoBarcodeConflict(
  db: Db,
  orgId: string,
  barcode: string,
  excludeProductId?: number,
  excludeVariantId?: number,
): Promise<void> {
  const productConditions = [
    eq(invProducts.orgId, orgId),
    eq(invProducts.barcode, barcode),
  ];
  if (excludeProductId !== undefined) {
    productConditions.push(ne(invProducts.id, excludeProductId));
  }
  const variantConditions = [
    eq(invProductVariants.orgId, orgId),
    eq(invProductVariants.barcode, barcode),
  ];
  if (excludeVariantId !== undefined) {
    variantConditions.push(ne(invProductVariants.id, excludeVariantId));
  }

  const [productHit, variantHit] = await Promise.all([
    db.query.invProducts.findFirst({
      where: and(...productConditions),
      columns: { id: true },
    }),
    db.query.invProductVariants.findFirst({
      where: and(...variantConditions),
      columns: { id: true },
    }),
  ]);
  if ((productHit ?? variantHit) !== undefined) {
    throw new ConflictException("Barcode already in use in this organisation");
  }
}
