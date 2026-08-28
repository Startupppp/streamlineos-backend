import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { invProducts, invProductVariants, invLots, invSerialNumbers, invLocations, invStockLevels } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { BarcodeLookupResult, ScanResult } from "./dto/inv-barcode.schemas";
import { parseGs1 } from "./gs1";

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

  /**
   * INV-203 — resolve one raw scan.
   *
   * A GS1 payload names several things at once, and the interesting failures
   * are the ones where each part resolves but they disagree: a batch label
   * scanned onto the wrong product still finds a real lot, just not that
   * product's lot. Resolving each element separately and then checking they
   * describe the same goods is the only way that surfaces.
   *
   * The raw payload travels back untouched. A traceability record has to be
   * able to show what the scanner read, not what we decided it meant.
   */
  async scan(orgId: string, payload: string): Promise<ScanResult> {
    const parsed = parseGs1(payload);
    const warnings: string[] = [];

    if (!parsed.isGs1) {
      // Not every scan is GS1, and most are not. Falling through to the plain
      // lookup keeps a keyboard wedge reading ordinary SKUs and bin labels.
      return { parsed, lookup: await this.lookup(orgId, parsed.raw), warnings };
    }

    const variant = parsed.gtin
      ? ((await this.db.query.invProductVariants.findFirst({
          where: and(
            eq(invProductVariants.orgId, orgId),
            eq(invProductVariants.barcode, parsed.gtin),
          ),
          columns: { id: true, productId: true, name: true, sku: true, isActive: true },
        })) ?? null)
      : null;

    if (parsed.gtin && !variant) {
      warnings.push(`No product variant carries GTIN ${parsed.gtin}`);
    }
    if (variant && !variant.isActive) {
      warnings.push(`Variant ${variant.sku} is not active`);
    }

    const lot = parsed.lotNumber
      ? ((await this.db.query.invLots.findFirst({
          where: and(
            eq(invLots.orgId, orgId),
            eq(invLots.lotNumber, parsed.lotNumber),
          ),
          columns: {
            id: true,
            productVariantId: true,
            lotNumber: true,
            status: true,
            expiryDate: true,
          },
        })) ?? null)
      : null;

    if (parsed.lotNumber && !lot) {
      warnings.push(`Lot ${parsed.lotNumber} is not on record`);
    }
    // The disagreement case: both halves exist, and they are not about the same
    // goods. Reading either in isolation looks entirely successful.
    if (lot && variant && lot.productVariantId !== variant.id) {
      warnings.push(
        `Lot ${lot.lotNumber} belongs to a different variant than GTIN ${parsed.gtin}`,
      );
    }
    if (lot && lot.status !== "ACTIVE") {
      warnings.push(`Lot ${lot.lotNumber} is ${lot.status}`);
    }
    // The label says one expiry and the record says another. Trusting the label
    // would let a reprint quietly extend shelf life.
    if (lot?.expiryDate && parsed.expiryDate && lot.expiryDate !== parsed.expiryDate) {
      warnings.push(
        `Label expiry ${parsed.expiryDate} does not match recorded expiry ${lot.expiryDate}`,
      );
    }

    const serial = parsed.serialNumber
      ? ((await this.db.query.invSerialNumbers.findFirst({
          where: and(
            eq(invSerialNumbers.orgId, orgId),
            eq(invSerialNumbers.serialNumber, parsed.serialNumber),
          ),
          columns: {
            id: true,
            productVariantId: true,
            serialNumber: true,
            status: true,
            currentLocationId: true,
          },
        })) ?? null)
      : null;

    if (serial && variant && serial.productVariantId !== variant.id) {
      warnings.push(
        `Serial ${serial.serialNumber} belongs to a different variant than GTIN ${parsed.gtin}`,
      );
    }

    return { parsed, variant, lot, serial, warnings };
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
