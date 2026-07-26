import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invProducts, invProductVariants, invLots, invSerialNumbers, invLocations, invStockLevels } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { BarcodeLookupResult } from "./dto/inv-barcode.schemas";

@Injectable()
export class InvBarcodeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async lookup(orgId: string, code: string): Promise<BarcodeLookupResult> {
    const [
      productByBarcode,
      variantByBarcode,
      variantBySku,
      productBySku,
      lot,
      serial,
      location,
    ] = await Promise.all([
      this.db.query.invProducts.findFirst({
        where: and(eq(invProducts.orgId, orgId), eq(invProducts.barcode, code)),
        columns: { id: true, name: true, sku: true, status: true },
      }),
      this.db.query.invProductVariants.findFirst({
        where: and(eq(invProductVariants.orgId, orgId), eq(invProductVariants.barcode, code)),
        columns: { id: true, productId: true, name: true, sku: true, isActive: true },
      }),
      this.db.query.invProductVariants.findFirst({
        where: and(eq(invProductVariants.orgId, orgId), eq(invProductVariants.sku, code)),
        columns: { id: true, productId: true, name: true, sku: true, isActive: true },
      }),
      this.db.query.invProducts.findFirst({
        where: and(eq(invProducts.orgId, orgId), eq(invProducts.sku, code)),
        columns: { id: true, name: true, sku: true, status: true },
      }),
      this.db.query.invLots.findFirst({
        where: and(eq(invLots.orgId, orgId), eq(invLots.lotNumber, code)),
        columns: { id: true, productVariantId: true, lotNumber: true, status: true },
      }),
      this.db.query.invSerialNumbers.findFirst({
        where: and(eq(invSerialNumbers.orgId, orgId), eq(invSerialNumbers.serialNumber, code)),
        columns: { id: true, productVariantId: true, serialNumber: true, status: true, currentLocationId: true },
      }),
      this.db.query.invLocations.findFirst({
        where: and(eq(invLocations.orgId, orgId), eq(invLocations.code, code)),
        columns: { id: true, warehouseId: true, name: true, code: true, locationType: true, isActive: true },
      }),
    ]);

    if (productByBarcode) {
      return { type: "product", productId: productByBarcode.id, name: productByBarcode.name, sku: productByBarcode.sku, status: productByBarcode.status, totalOnHand: await this.productStock(orgId, productByBarcode.id) };
    }
    if (variantByBarcode) {
      return { type: "variant", variantId: variantByBarcode.id, productId: variantByBarcode.productId, name: variantByBarcode.name, sku: variantByBarcode.sku, isActive: variantByBarcode.isActive, totalOnHand: await this.variantStock(orgId, variantByBarcode.id) };
    }
    if (variantBySku) {
      return { type: "variant", variantId: variantBySku.id, productId: variantBySku.productId, name: variantBySku.name, sku: variantBySku.sku, isActive: variantBySku.isActive, totalOnHand: await this.variantStock(orgId, variantBySku.id) };
    }
    if (productBySku) {
      return { type: "product", productId: productBySku.id, name: productBySku.name, sku: productBySku.sku, status: productBySku.status, totalOnHand: await this.productStock(orgId, productBySku.id) };
    }
    if (lot) {
      return { type: "lot", lotId: lot.id, variantId: lot.productVariantId, lotNumber: lot.lotNumber, status: lot.status };
    }
    if (serial) {
      return { type: "serial", serialId: serial.id, variantId: serial.productVariantId, serialNumber: serial.serialNumber, status: serial.status, currentLocationId: serial.currentLocationId };
    }
    if (location) {
      return { type: "location", locationId: location.id, warehouseId: location.warehouseId, name: location.name, code: location.code, locationType: location.locationType, isActive: location.isActive };
    }

    return { type: "not_found" };
  }

  private async productStock(orgId: string, productId: number): Promise<string> {
    const result = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')` })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .where(and(eq(invProductVariants.orgId, orgId), eq(invProductVariants.productId, productId)));
    return result[0]?.total ?? "0";
  }

  private async variantStock(orgId: string, variantId: number): Promise<string> {
    const result = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')` })
      .from(invStockLevels)
      .where(and(eq(invStockLevels.orgId, orgId), eq(invStockLevels.productVariantId, variantId)));
    return result[0]?.total ?? "0";
  }
}
