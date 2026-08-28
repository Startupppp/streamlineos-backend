import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { invProducts, invProductVariants, invLots, invSerialNumbers, invLocations, invStockLevels, invIdempotencyKeys } from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { claimIdempotencyKey } from "../stock-engine/idempotency";
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
        // Archived rows must not resolve: scanning a deleted SKU at the shelf
        // returned it as a live variant.
        where: and(eq(invProducts.orgId, orgId), eq(invProducts.barcode, code), isNull(invProducts.deletedAt)),
        columns: { id: true, name: true, sku: true, status: true },
      }),
      this.db.query.invProductVariants.findFirst({
        where: and(eq(invProductVariants.orgId, orgId), eq(invProductVariants.barcode, code), isNull(invProductVariants.deletedAt)),
        columns: { id: true, productId: true, name: true, sku: true, isActive: true },
      }),
      this.db.query.invProductVariants.findFirst({
        where: and(eq(invProductVariants.orgId, orgId), eq(invProductVariants.sku, code), isNull(invProductVariants.deletedAt)),
        columns: { id: true, productId: true, name: true, sku: true, isActive: true },
      }),
      this.db.query.invProducts.findFirst({
        where: and(eq(invProducts.orgId, orgId), eq(invProducts.sku, code), isNull(invProducts.deletedAt)),
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
            isNull(invProductVariants.deletedAt),
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

  /**
   * INV-203 — capture a scan as a fact, before anything acts on it.
   *
   * `scan` reads; this one records. The phase requires the capture to exist
   * independently of whatever stock command follows, because the two fail
   * separately: a warehouse where the putaway was rejected still needs to know
   * the pallet was scanned at the door, and reconstructing that from a stock
   * movement that never happened is not possible.
   *
   * Idempotent on the caller's key, which is what makes it safe on a device
   * that retries. A scanner on a failing network sends the same scan several
   * times, and three facts for one physical event would corrupt a throughput
   * count as surely as none would.
   *
   * The fact and the idempotency claim share the transaction. Emitting the
   * event outside it would leave a fact for a capture that rolled back.
   */
  async captureScan(
    orgId: string,
    userId: string,
    idempotencyKey: string,
    payload: string,
  ): Promise<ScanResult & { captured: boolean }> {
    const requestHash = createHash("sha256").update(payload).digest("hex");

    return this.db.transaction(async (tx) => {
      const claim = await claimIdempotencyKey(tx, orgId, idempotencyKey, requestHash);
      if (claim.kind === "replay") {
        // The prior request already emitted the fact. Returning its stored
        // result rather than re-resolving keeps a retry and its original
        // answering the same thing even if the catalogue moved in between.
        return { ...(claim.stored as ScanResult), captured: false };
      }

      const result = await this.scan(orgId, payload);

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "inv_scan",
        aggregateId: idempotencyKey,
        aggregateVersion: Date.now(),
        eventType: "inventory.scan.captured",
        payload: {
          // The raw payload is the point of the record. What we decided it
          // meant is an interpretation and may later be shown to be wrong.
          raw: result.parsed.raw,
          isGs1: result.parsed.isGs1,
          gtin: result.parsed.gtin ?? null,
          lotNumber: result.parsed.lotNumber ?? null,
          serialNumber: result.parsed.serialNumber ?? null,
          resolvedVariantId: result.variant?.id ?? null,
          resolvedLotId: result.lot?.id ?? null,
          resolvedSerialId: result.serial?.id ?? null,
          warnings: result.warnings,
          capturedBy: userId,
        },
        occurredAt: new Date(),
        actorMembershipId: null,
      });

      await tx
        .update(invIdempotencyKeys)
        .set({
          status: "COMPLETED",
          response: { ...result } as Record<string, unknown>,
        })
        .where(
          and(
            eq(invIdempotencyKeys.orgId, orgId),
            eq(invIdempotencyKeys.idempotencyKey, idempotencyKey),
          ),
        );

      return { ...result, captured: true };
    });
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
