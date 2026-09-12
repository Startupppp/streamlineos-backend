import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { InvProductCrudService } from "src/modules/inventory/products/inv-product-crud.service";
import { InvPharmacyService } from "src/modules/inventory/products/inv-pharmacy.service";
import { InvQuantityCaptureService } from "src/modules/inventory/products/inv-quantity-capture.service";
import { SettingsService } from "src/modules/inventory/settings/settings.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * E3 / E4 — the pharmacy and kirana packs, doing something.
 *
 * The failure this suite exists to catch is a flag that reads as configured and
 * changes nothing. So every case is stated twice: once with the pack off, where
 * the field must not be writable, must not appear in a response, and must impose
 * no rule; and once with it on, where the same call behaves differently.
 *
 * Every figure asserted is worked by hand and written as a literal. A test that
 * recomputes the conversion it is checking only proves the implementation agrees
 * with itself:
 *
 *   500 g at a factor of 0.001 to the kilogram   →  0.5000 base units
 *   25 kg at the base unit's factor of 1          →  25.0000 base units
 *   2.995 kg at a scale precision of 3            →  2.9950 base units, exactly
 */

interface Scene {
  orgId: string;
  userId: string;
  kgUomId: number;
  gramUomId: number;
  /** Loose goods: stocked in kilograms, sold in grams. */
  riceProductId: number;
  riceVariantId: number;
  /** Lot-tracked Schedule H1 medicine. */
  drugProductId: number;
  drugVariantId: number;
  /** Shares the drug's LASA group — the reason the warning is useful. */
  lookalikeProductId: number;
}

/** The MRP printed on the carton: ₹125.50, held as paise. */
const DRUG_MRP_PAISE = 12_550;

describe("[seeded-e2e] E3/E4 pharmacy and kirana pack fields", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  const products = () => app.app.get(InvProductCrudService);
  const pharmacy = () => app.app.get(InvPharmacyService);
  const capture = () => app.app.get(InvQuantityCaptureService);
  const settings = () => app.app.get(SettingsService);

  /**
   * Flips a pack through the real settings service and then proves it landed.
   * A `beforeAll` that turns a flag on and does not check is how a suite ends up
   * asserting the pack-off behaviour twice and calling it a pass.
   */
  const setPacks = async (patch: Record<string, unknown>) => {
    await asTenant(() => settings().updateSettings(scene.orgId, scene.userId, patch));
    const [row] = await asTenant(() =>
      db().execute<{ pharmacy: boolean; kirana: boolean }>(sql`
        SELECT pack_pharmacy AS pharmacy, pack_kirana AS kirana
        FROM inv_settings WHERE org_id = ${scene.orgId}`),
    );
    const resolved = await asTenant(() => settings().getPacks(scene.orgId));
    return { stored: row, resolved };
  };

  /** The error code a refusal carried, or null when the call succeeded. */
  const refusalCode = async (work: () => Promise<unknown>): Promise<string | null> => {
    try {
      await work();
      return null;
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      const body = err.getResponse();
      return typeof body === "object" && body !== null && "code" in body
        ? String((body as { code: unknown }).code)
        : "BAD_REQUEST";
    }
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:products:read",
          "inventory:products:create",
          "inventory:products:update",
          "inventory:settings:manage",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6).toUpperCase();
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;

      const kg = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Kilogram ${tag}`}, ${`KG${tag}`}, true) RETURNING id`);
      const gram = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Gram ${tag}`}, ${`G${tag}`}, false) RETURNING id`);

      const rice = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, sales_uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${kg.id}, ${gram.id}, 'Loose rice', ${`RICE-${tag}`}, ${userId})
        RETURNING id`);
      const riceVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${rice.id}, 'Default', ${`RICE-${tag}-V`}) RETURNING id`);

      const drug = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${kg.id}, 'Amoxil 250', ${`AMX-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const drugVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${drug.id}, 'Default', ${`AMX-${tag}-V`}) RETURNING id`);

      const lookalike = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${kg.id}, 'Amoxil Forte', ${`AMXF-${tag}`}, ${userId})
        RETURNING id`);
      await db().execute(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${lookalike.id}, 'Default', ${`AMXF-${tag}-V`})`);

      return {
        orgId: seeded.orgId,
        userId,
        kgUomId: kg.id,
        gramUomId: gram.id,
        riceProductId: rice.id,
        riceVariantId: riceVariant.id,
        drugProductId: drug.id,
        drugVariantId: drugVariant.id,
        lookalikeProductId: lookalike.id,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  describe("packs off — the default an ordinary distributor lands on", () => {
    it("refuses to write a pharmacy field and refuses to write a kirana field", async () => {
      await expect(
        refusalCode(() =>
          asTenant(() => products().updateProduct(scene.orgId, scene.drugProductId, { mrpPaise: DRUG_MRP_PAISE })),
        ),
      ).resolves.toBe("PHARMACY_PACK_DISABLED");
      await expect(
        refusalCode(() =>
          asTenant(() => products().updateProduct(scene.orgId, scene.riceProductId, { saleMode: "LOOSE" })),
        ),
      ).resolves.toBe("KIRANA_PACK_DISABLED");
    });

    it("does not return either pack's fields on a product read", async () => {
      const product = (await asTenant(() =>
        products().getProduct(scene.orgId, scene.drugProductId, scene.userId),
      )) as Record<string, unknown>;
      // Absent, not null. A client that never sees a field cannot start
      // depending on it, and an operator never has to explain an empty
      // `drugSchedule` on a screen that has no such concept.
      expect("mrpPaise" in product).toBe(false);
      expect("drugSchedule" in product).toBe(false);
      expect("saleMode" in product).toBe(false);
      expect("quantityInputMode" in product).toBe(false);
      // The columns that are not behind a pack are still there.
      expect(product["sku"]).toBeDefined();
    });

    it("imposes no receipt requirement, on the very SKU that is lot-tracked", async () => {
      await expect(
        asTenant(() => pharmacy().receiptRequirements(scene.orgId, scene.drugVariantId)),
      ).resolves.toEqual({
        mrpRequired: false,
        lotRequired: false,
        expiryRequired: false,
        suggestedMrpPaise: null,
      });
      // And the gate is a no-op on a line carrying nothing at all.
      await expect(
        asTenant(() => pharmacy().assertReceiptLine(scene.orgId, scene.drugVariantId, {})),
      ).resolves.toBeUndefined();
    });

    it("imposes no entry rule, and still converts", async () => {
      const contract = await asTenant(() =>
        capture().captureContract(scene.orgId, scene.riceVariantId, { quantity: "2.9955" }),
      );
      expect(contract.packEnabled).toBe(false);
      // Null, not the stored defaults: with the pack off there is no contract to
      // honour, which is what makes the flag real rather than cosmetic.
      expect(contract.rules).toBeNull();
      expect(contract.snapshot).toEqual({
        quantityEntered: "2.9955",
        uomId: null,
        uomFactor: "1.000000",
        quantity: "2.9955",
      });
    });

    it("answers the H1 register with the reason it is unavailable, not an empty list", async () => {
      await expect(
        asTenant(() => pharmacy().h1Register(scene.orgId, { page: 1, limit: 50 })),
      ).resolves.toMatchObject({ enabled: false, reason: "PHARMACY_PACK_DISABLED" });
    });
  });

  describe("pharmacy pack on", () => {
    beforeAll(async () => {
      const flipped = await setPacks({ packPharmacy: true });
      expect(flipped).toMatchObject({
        stored: { pharmacy: true },
        resolved: { pharmacy: true },
      });
      await asTenant(() =>
        products().updateProduct(scene.orgId, scene.drugProductId, {
          mrpPaise: DRUG_MRP_PAISE,
          mrpRequired: true,
          drugSchedule: "H1",
          isHighAlert: true,
          lasaGroup: "amoxicillin",
        }),
      );
      await asTenant(() =>
        products().updateProduct(scene.orgId, scene.lookalikeProductId, { lasaGroup: "amoxicillin" }),
      );
    }, 60_000);

    it("returns the pharmacy fields on a read, MRP intact as an integer", async () => {
      const product = (await asTenant(() =>
        products().getProduct(scene.orgId, scene.drugProductId, scene.userId),
      )) as Record<string, unknown>;
      expect(product["mrpPaise"]).toBe(DRUG_MRP_PAISE);
      expect(product["drugSchedule"]).toBe("H1");
      // The kirana pack is still off, so its fields stay hidden on the same row.
      expect("saleMode" in product).toBe(false);
    });

    it("warns at dispense and blocks nothing", async () => {
      const profile = await asTenant(() =>
        pharmacy().dispensingProfile(scene.orgId, scene.drugVariantId),
      );
      expect(profile.packEnabled).toBe(true);
      expect(profile.safety.blocksDispense).toBe(false);
      expect(profile.safety.acknowledgementRequired).toBe(true);
      expect(profile.safety.alerts.map((a) => a.code)).toEqual([
        "LASA",
        "HIGH_ALERT",
        "PRESCRIPTION_REQUIRED",
        "REGISTER_ENTRY_REQUIRED",
      ]);
      // The confusable sibling is named, because "this one is confusable" alone
      // is useless at the shelf.
      expect(profile.confusableWith.map((c) => c.productId)).toEqual([scene.lookalikeProductId]);
      expect(profile.safety.alerts[0]!.message).toContain("Amoxil Forte");
    });

    it("blocks a receipt with no MRP, no batch or no expiry — the three that stop existing", async () => {
      await expect(
        asTenant(() => pharmacy().receiptRequirements(scene.orgId, scene.drugVariantId)),
      ).resolves.toEqual({
        mrpRequired: true,
        lotRequired: true,
        expiryRequired: true,
        suggestedMrpPaise: DRUG_MRP_PAISE,
      });

      const complete = { mrpPaise: DRUG_MRP_PAISE, lotNumber: "B-2409", expiryDate: "2027-03-31" };
      await expect(
        asTenant(() => pharmacy().assertReceiptLine(scene.orgId, scene.drugVariantId, complete)),
      ).resolves.toBeUndefined();

      await expect(
        refusalCode(() =>
          asTenant(() => pharmacy().assertReceiptLine(scene.orgId, scene.drugVariantId, { ...complete, mrpPaise: null })),
        ),
      ).resolves.toBe("MRP_REQUIRED");
      await expect(
        refusalCode(() =>
          asTenant(() => pharmacy().assertReceiptLine(scene.orgId, scene.drugVariantId, { ...complete, lotNumber: null })),
        ),
      ).resolves.toBe("LOT_REQUIRED");
      await expect(
        refusalCode(() =>
          asTenant(() => pharmacy().assertReceiptLine(scene.orgId, scene.drugVariantId, { ...complete, expiryDate: null })),
        ),
      ).resolves.toBe("EXPIRY_REQUIRED");
      // ₹130.00 paid for a pack printed ₹125.50 — the transposed pair.
      await expect(
        refusalCode(() =>
          asTenant(() =>
            pharmacy().assertReceiptLine(scene.orgId, scene.drugVariantId, { ...complete, purchaseRatePaise: 13_000 }),
          ),
        ),
      ).resolves.toBe("PURCHASE_RATE_ABOVE_MRP");
    });

    it("refuses an MRP of zero at the database, not only in the DTO", async () => {
      // The CHECK is what makes it true against a direct write. NULL says
      // "not recorded"; zero would say "free".
      await expect(
        asTenant(() =>
          db().execute(sql`
            UPDATE inv_products SET mrp_paise = 0
            WHERE org_id = ${scene.orgId} AND id = ${scene.drugProductId}`),
        ),
      ).rejects.toThrow();
    });

    it("keeps the register off until its own jurisdiction flag is set", async () => {
      await expect(
        asTenant(() => pharmacy().h1Register(scene.orgId, { page: 1, limit: 50 })),
      ).resolves.toMatchObject({ enabled: false, reason: "H1_REGISTER_DISABLED" });
    });

    it("exports the register scope once enabled, and says it is not a return", async () => {
      await setPacks({ pharmacyH1RegisterEnabled: true });
      const register = (await asTenant(() =>
        pharmacy().h1Register(scene.orgId, { page: 1, limit: 50 }),
      )) as {
        enabled: boolean;
        authoritative: boolean;
        dispensingRows: null;
        items: Array<{ productId: number; mrpPaise: number | null }>;
        pagination: { total: number };
      };
      expect(register.enabled).toBe(true);
      expect(register.authoritative).toBe(false);
      expect(register.dispensingRows).toBeNull();
      // Exactly one Schedule H1 SKU exists in this freshly seeded organisation.
      expect(register.pagination.total).toBe(1);
      expect(register.items).toEqual([
        expect.objectContaining({ productId: scene.drugProductId, mrpPaise: DRUG_MRP_PAISE }),
      ]);
    });

    it("refuses to turn the pack off underneath the enabled register", async () => {
      await expect(refusalCode(() => setPacks({ packPharmacy: false }))).resolves.toBe("BAD_REQUEST");
      await setPacks({ pharmacyH1RegisterEnabled: false });
    });
  });

  describe("kirana pack on", () => {
    beforeAll(async () => {
      const flipped = await setPacks({ packKirana: true });
      expect(flipped).toMatchObject({ stored: { kirana: true }, resolved: { kirana: true } });
    }, 60_000);

    it("refuses to make a SKU loose while its selling unit has no conversion", async () => {
      await expect(
        refusalCode(() =>
          asTenant(() =>
            products().updateProduct(scene.orgId, scene.riceProductId, {
              saleMode: "LOOSE",
              quantityInputMode: "SCALE",
              quantityPrecision: 3,
            }),
          ),
        ),
      ).resolves.toBe("UOM_CONVERSION_MISSING");
    });

    it("accepts the loose configuration once the gram-to-kilogram factor exists", async () => {
      await asTenant(() =>
        db().execute(sql`
          INSERT INTO inv_product_uom_conversions (org_id, product_id, uom_id, factor_to_base)
          VALUES (${scene.orgId}, ${scene.riceProductId}, ${scene.gramUomId}, 0.001)`),
      );
      await expect(
        asTenant(() =>
          products().updateProduct(scene.orgId, scene.riceProductId, {
            saleMode: "LOOSE",
            quantityInputMode: "SCALE",
            quantityPrecision: 3,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it("refuses an incoherent entry contract before it reaches the database", async () => {
      await expect(
        refusalCode(() =>
          asTenant(() =>
            products().updateProduct(scene.orgId, scene.riceProductId, { quantityPrecision: 0 }),
          ),
        ),
      ).resolves.toBe("QTY_PRECISION_OUT_OF_RANGE");
      await expect(
        refusalCode(() =>
          asTenant(() =>
            products().updateProduct(scene.orgId, scene.riceProductId, { quantityInputMode: "WHOLE" }),
          ),
        ),
      ).resolves.toBe("LOOSE_NEEDS_MEASURED_ENTRY");
    });

    it("receives 25 kg and sells 500 g through the same stock balance", async () => {
      // Received in the stock unit: no conversion, and the ledger figure is the
      // entered one.
      const received = await asTenant(() =>
        capture().captureContract(scene.orgId, scene.riceVariantId, {
          quantity: "25",
          uomId: scene.kgUomId,
        }),
      );
      expect(received.snapshot).toEqual({
        quantityEntered: "25",
        uomId: scene.kgUomId,
        uomFactor: "1.000000",
        quantity: "25.0000",
      });

      // Sold in grams: 500 × 0.001 = 0.5 kg. The factor travels with the line,
      // so a later correction to the case size cannot rewrite this sale.
      const sold = await asTenant(() =>
        capture().captureContract(scene.orgId, scene.riceVariantId, {
          quantity: "500",
          uomId: scene.gramUomId,
        }),
      );
      expect(sold.snapshot).toEqual({
        quantityEntered: "500",
        uomId: scene.gramUomId,
        uomFactor: "0.00100000",
        quantity: "0.5000",
      });
      expect(sold.rules).toEqual({ saleMode: "LOOSE", inputMode: "SCALE", precision: 3 });
      expect(sold.salesUom?.id).toBe(scene.gramUomId);
    });

    it("takes a scale reading at its own precision and refuses one digit more", async () => {
      const weighed = await asTenant(() =>
        capture().captureContract(scene.orgId, scene.riceVariantId, { quantity: "2.995" }),
      );
      expect(weighed.snapshot).toEqual({
        quantityEntered: "2.995",
        uomId: null,
        uomFactor: "1.000000",
        quantity: "2.9950",
      });
      // The same call that succeeded with the pack off now refuses. That is the
      // flag changing behaviour, on identical input.
      await expect(
        refusalCode(() =>
          asTenant(() => capture().captureContract(scene.orgId, scene.riceVariantId, { quantity: "2.9955" })),
        ),
      ).resolves.toBe("QUANTITY_PRECISION_EXCEEDED");
    });

    it("refuses a fraction of a countable SKU", async () => {
      await expect(
        refusalCode(() =>
          asTenant(() => capture().assertEnteredQuantity(scene.orgId, scene.drugVariantId, "1.5")),
        ),
      ).resolves.toBe("QUANTITY_MUST_BE_WHOLE");
      await expect(
        asTenant(() => capture().assertEnteredQuantity(scene.orgId, scene.drugVariantId, "2")),
      ).resolves.toBeUndefined();
    });

    it("returns both packs' fields now that both are on", async () => {
      const product = (await asTenant(() =>
        products().getProduct(scene.orgId, scene.riceProductId, scene.userId),
      )) as Record<string, unknown>;
      expect(product["saleMode"]).toBe("LOOSE");
      expect(product["quantityInputMode"]).toBe("SCALE");
      expect(product["quantityPrecision"]).toBe(3);
      expect(product["mrpRequired"]).toBe(false);
      // The gst pack was never turned on, so its fields are still absent.
      expect("hsnCode" in product).toBe(false);
    });
  });
});
