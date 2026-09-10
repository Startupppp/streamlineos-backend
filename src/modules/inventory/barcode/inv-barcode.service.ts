import { createHash, randomUUID } from "node:crypto";
import { InvPharmacyService } from "../products/inv-pharmacy.service";
import QRCode from "qrcode";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { invProducts, invProductVariants, invLots, invSerialNumbers, invLocations, invStockLevels, invIdempotencyKeys, invUom, organizations } from "../../../db/schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { claimIdempotencyKey } from "../stock-engine/idempotency";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { type Db } from "../../../db/drizzle.module";
import type { BarcodeLookupResult, LabelPayload, ScanResult } from "./dto/inv-barcode.schemas";
import { formatGs1, parseGs1 } from "./gs1";

@Injectable()
export class InvBarcodeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly pharmacy: InvPharmacyService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * Resolve one code.
   *
   * **This method answers two questions with two different scopes, and the
   * split is the rule for this folder.** Nothing here scoped anything before,
   * so read this before narrowing or widening either half.
   *
   * *What is this?* — a catalogue question, answered **organisation-wide**, and
   * it must stay that way. Goods move between buildings; a GTIN, a SKU, a lot
   * number and a serial are facts about the organisation's catalogue, not about
   * a warehouse. Scoping identity would also break both internal callers —
   * `PickConfirmService.resolveScan` and `PackagesService.resolveScan` match a
   * scan against the line in hand by identity alone, and a picker holding a box
   * that arrived on a transfer from another site would be told their own pick
   * line does not match what is in their hand.
   *
   * *How much of it is there?* — a stock question, answered **only for the
   * warehouses the caller holds**. `inventory:stock:read` gates this route, and
   * every other surface carrying that same key is already scoped: `GET
   * /inventory/stock`, `GET /inventory/stock/availability` and
   * `KitService.buildable` all narrow through `WarehouseScopeService`. The rule
   * was not invented here; barcode was the one surface that had not adopted it.
   *
   * The cross-building enquiry exists and is separately permissioned already:
   * `inventory:warehouses:scope-all` ("See and transact in every warehouse,
   * bypassing warehouse assignment") makes the scope unrestricted, so a
   * caller holding it gets exactly the organisation-wide totals this returned
   * before. **Do not "restore" the org-wide sum by deleting the scope call** —
   * that is not restoring a feature, it is removing the gate from one that
   * already ships.
   *
   * A bin is the one identity that *is* scoped, because a bin does not move. A
   * location code resolves to a building, so resolving one for a caller who
   * does not hold that building tells them a bin exists there and what it is
   * called. That is the existence oracle `assertWarehouseVisible` refuses by
   * answering NotFound rather than Forbidden, and this answers `not_found` for
   * the same reason. No workflow is lost: an operator has to be standing in a
   * building to scan a bin label in it.
   */
  async lookup(orgId: string, userId: string, code: string): Promise<BarcodeLookupResult> {
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
      return { type: "product", productId: productByBarcode.id, name: productByBarcode.name, sku: productByBarcode.sku, status: productByBarcode.status, totalOnHand: await this.productStock(orgId, userId, productByBarcode.id) };
    }
    if (variantByBarcode) {
      return { type: "variant", variantId: variantByBarcode.id, productId: variantByBarcode.productId, name: variantByBarcode.name, sku: variantByBarcode.sku, isActive: variantByBarcode.isActive, totalOnHand: await this.variantStock(orgId, userId, variantByBarcode.id) };
    }
    if (variantBySku) {
      return { type: "variant", variantId: variantBySku.id, productId: variantBySku.productId, name: variantBySku.name, sku: variantBySku.sku, isActive: variantBySku.isActive, totalOnHand: await this.variantStock(orgId, userId, variantBySku.id) };
    }
    if (productBySku) {
      return { type: "product", productId: productBySku.id, name: productBySku.name, sku: productBySku.sku, status: productBySku.status, totalOnHand: await this.productStock(orgId, userId, productBySku.id) };
    }
    if (lot) {
      return { type: "lot", lotId: lot.id, variantId: lot.productVariantId, lotNumber: lot.lotNumber, status: lot.status };
    }
    if (serial) {
      return { type: "serial", serialId: serial.id, variantId: serial.productVariantId, serialNumber: serial.serialNumber, status: serial.status, currentLocationId: serial.currentLocationId };
    }
    if (location) {
      // The one scoped identity — see the note on this method. A bin in a
      // building the caller does not hold does not resolve, rather than
      // resolving and naming that building back to them.
      const scope = await this.warehouseScope.resolve(orgId, userId);
      if (scope !== null && !scope.includes(location.warehouseId)) return { type: "not_found" };
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
  /**
   * E3 — the LASA and high-alert warnings, on the surface a person actually
   * touches.
   *
   * `GET /inventory/products/variants/:variantId/pharmacy` returned these and
   * nothing called it. A picker does not open a product page mid-walk; they
   * scan. So a look-alike/sound-alike warning existed, was tested, and reached
   * nobody — which for this class of warning is the difference between the pack
   * being real and being a record that somebody thought about safety.
   *
   * Merged into `warnings` rather than added as a second field: the scan surface
   * already has one channel for "read this before you act", and a second one is
   * a channel somebody renders in only half the places.
   *
   * `blocksDispense` is deliberately not consulted. It is `false` by
   * construction and a scan is not a dispense — this shows, it never refuses.
   * A safety warning that blocks the scanner turns a caution into an outage.
   *
   * No variant means no SKU to be unsafe about, and asking anyway would be a
   * query per failed scan on the hottest path in the module.
   */
  private async appendSafetyWarnings(
    orgId: string,
    productVariantId: number | null,
    warnings: string[],
  ): Promise<void> {
    if (productVariantId === null) return;
    const profile = await this.pharmacy.dispensingProfile(orgId, productVariantId);
    for (const alert of profile.safety.alerts) {
      warnings.push(
        alert.disposition === "ACKNOWLEDGE"
          ? `Confirm before use: ${alert.message}`
          : alert.message,
      );
    }
  }

  async scan(orgId: string, userId: string, payload: string): Promise<ScanResult> {
    const parsed = parseGs1(payload);
    const warnings: string[] = [];

    if (!parsed.isGs1) {
      // Not every scan is GS1, and most are not. Falling through to the plain
      // lookup keeps a keyboard wedge reading ordinary SKUs and bin labels.
      //
      // E3. The safety alerts belong on this path too, and this is the *common*
      // one — a picker scanning a plain SKU barcode is the ordinary case, and a
      // LASA warning that only fired for GS1 labels would miss most scans.
      const lookup = await this.lookup(orgId, userId, parsed.raw);
      const variantId =
        lookup.type === "variant"
          ? lookup.variantId
          : lookup.type === "lot" || lookup.type === "serial"
            ? lookup.variantId
            : null;
      await this.appendSafetyWarnings(orgId, variantId, warnings);
      return { parsed, lookup, warnings };
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
    await this.appendSafetyWarnings(orgId, variant?.id ?? null, warnings);

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

      const result = await this.scan(orgId, userId, payload);

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

  /**
   * G4 — everything a printed label needs, resolved from the goods rather than
   * assembled by whoever is printing.
   *
   * The inverse of `lookup`, and it lives beside it deliberately: the one thing a
   * label must guarantee is that scanning it comes back to the SKU it came off,
   * and an encoder that lives away from the decoder is how a warehouse ends up
   * with a shelf of labels its own scanners cannot read.
   *
   * `code` is therefore chosen for resolvability, not for prettiness. The
   * variant's barcode where it has one, its SKU otherwise — `lookup` resolves
   * both, and both are unique per organisation. The GS1 element string is offered
   * alongside rather than instead: it carries the lot and expiry a batch label
   * needs, `POST /inventory/barcode/scan` reads it, and it exists only where the
   * variant carries a real GTIN.
   *
   * The QR encodes the richer of the two, so one scan resolves as much as the
   * label knows. Rendering is the caller's business — this returns a payload, not
   * a picture of one, because label stock, symbology and copy count are decisions
   * made at the printer.
   */
  async buildLabel(
    orgId: string,
    productVariantId: number,
    lotId?: number,
  ): Promise<LabelPayload> {
    const [variant] = await this.db
      .select({
        id: invProductVariants.id,
        productId: invProductVariants.productId,
        variantName: invProductVariants.name,
        sku: invProductVariants.sku,
        barcode: invProductVariants.barcode,
        productName: invProducts.name,
        productBarcode: invProducts.barcode,
        uom: invUom.abbreviation,
      })
      .from(invProductVariants)
      .innerJoin(invProducts, eq(invProducts.id, invProductVariants.productId))
      .leftJoin(invUom, eq(invUom.id, invProducts.uomId))
      .where(
        and(
          eq(invProductVariants.orgId, orgId),
          eq(invProductVariants.id, productVariantId),
          // An archived SKU must not print: a label is an instruction to put
          // goods on a shelf under a code that no longer resolves.
          isNull(invProductVariants.deletedAt),
        ),
      )
      .limit(1);

    if (!variant) throw new NotFoundException("Product variant not found");

    const lot = lotId
      ? ((await this.db.query.invLots.findFirst({
          where: and(
            eq(invLots.orgId, orgId),
            eq(invLots.id, lotId),
            // The pairing check: a lot belongs to exactly one variant, and a
            // label showing this SKU over another batch's number is the single
            // most expensive thing this endpoint could produce.
            eq(invLots.productVariantId, productVariantId),
          ),
          columns: { id: true, lotNumber: true, expiryDate: true, manufactureDate: true },
        })) ?? null)
      : null;

    if (lotId && !lot)
      throw new NotFoundException("Lot not found for this product variant");

    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    const gtin = variant.barcode ?? variant.productBarcode;
    const code = variant.barcode ?? variant.sku;
    const gs1 = formatGs1({
      gtin,
      lotNumber: lot?.lotNumber ?? null,
      expiryDate: lot?.expiryDate ?? null,
    });

    return {
      productVariantId: variant.id,
      productId: variant.productId,
      productName: variant.productName,
      variantName: variant.variantName,
      sku: variant.sku,
      code,
      codeSource: variant.barcode ? "barcode" : "sku",
      uom: variant.uom ?? null,
      lot: lot
        ? {
            lotId: lot.id,
            lotNumber: lot.lotNumber,
            expiryDate: lot.expiryDate ?? null,
            manufactureDate: lot.manufactureDate ?? null,
          }
        : null,
      gs1,
      qrDataUri: await QRCode.toDataURL(gs1 ?? code, { margin: 1, width: 256 }),
      printedAt: new Date().toISOString(),
      organizationName: org?.name ?? "",
    };
  }

  /**
   * On hand, **in the buildings this caller holds** — not across the estate.
   *
   * Both helpers below sum `inv_stock_levels`, which is keyed on a location, so
   * neither can be scoped without joining `inv_locations` for its
   * `warehouse_id`. That join is the whole mechanism, and it is the same one
   * `KitService.availableByComponent` uses; if either helper ever loses it, the
   * number silently goes organisation-wide again and nothing fails.
   *
   * `inventory:warehouses:scope-all` (`SCOPE_ALL_PERMISSION`) resolves the
   * scope to `null` — unrestricted — so the org-wide total is still available
   * to whoever the org has granted it to. That is the cross-building enquiry,
   * and it is a grant, not a default.
   *
   * A caller assigned to no warehouse at all gets "0" without the query
   * running, matching `KitService.buildable`.
   *
   * On the product that this is a worse answer for a picker hunting stock: the
   * org-wide number never answered that question either. "4 on hand" with no
   * building attached, to someone who then cannot find them on their own
   * shelves, is a number that misleads in exactly the case that matters. "0
   * here" is true. Where it is in the estate is a different screen's answer,
   * and it needs the warehouse named alongside the quantity to be worth
   * anything — which is why widening *this* field was never the fix for it.
   */
  private async productStock(orgId: string, userId: string, productId: number): Promise<string> {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    if (scope !== null && scope.length === 0) return "0";

    const result = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')` })
      .from(invStockLevels)
      .innerJoin(invProductVariants, eq(invStockLevels.productVariantId, invProductVariants.id))
      .innerJoin(
        invLocations,
        and(
          eq(invLocations.id, invStockLevels.locationId),
          eq(invLocations.orgId, invStockLevels.orgId),
        ),
      )
      .where(
        and(
          eq(invProductVariants.orgId, orgId),
          eq(invProductVariants.productId, productId),
          this.warehouseScope.warehousePredicate(scope, sql`${invLocations.warehouseId}`),
        ),
      );
    return result[0]?.total ?? "0";
  }

  /** Scoped for the reasons on `productStock` above. */
  private async variantStock(orgId: string, userId: string, variantId: number): Promise<string> {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    if (scope !== null && scope.length === 0) return "0";

    const result = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')` })
      .from(invStockLevels)
      .innerJoin(
        invLocations,
        and(
          eq(invLocations.id, invStockLevels.locationId),
          eq(invLocations.orgId, invStockLevels.orgId),
        ),
      )
      .where(
        and(
          eq(invStockLevels.orgId, orgId),
          eq(invStockLevels.productVariantId, variantId),
          this.warehouseScope.warehousePredicate(scope, sql`${invLocations.warehouseId}`),
        ),
      );
    return result[0]?.total ?? "0";
  }
}
