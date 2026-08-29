import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { GrnPostingService } from "src/modules/inventory/purchase-orders/grn-post.service";
import { SettingsService } from "src/modules/inventory/settings/settings.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * E3 / E4 at the seam — does posting a receipt actually behave differently.
 *
 * The rules themselves are unit-tested and were, for a while, called by nobody:
 * `assertReceiptLine` refused correctly in isolation and the GRN post never
 * asked it, so E3's "a GRN without MRP on a flagged SKU fails" was false in the
 * only place it means anything. A test of the service cannot show that. This one
 * drives `GrnService.receiveGoods`, which opens the receipt and posts it under
 * one idempotency claim, and asserts on the ledger and the documents afterwards.
 *
 * Both packs default OFF, so the first block asserts the unflagged path is
 * untouched — a gate that changes tenants who never enabled it is worse than no
 * gate at all. Every figure is worked by hand:
 *
 *   10 units received on a lot-tracked SKU        →  on_hand 10.0000
 *   2.995 kg received against a 100 kg order      →  on_hand 2.9950
 *   MRP ₹125.50 printed on the carton             →  12550 paise, on line and lot
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:receive",
  "inventory:stock:read",
  "inventory:settings:manage",
] as const;

/** ₹125.50 printed on the carton, and ₹90.00 actually paid for it. */
const MRP_PAISE = 12_550;
const PURCHASE_RATE_PAISE = 9_000;

interface Scene {
  orgId: string;
  userId: string;
  /** Lot-tracked Schedule H1 medicine, flagged `mrp_required`. */
  drugProductId: number;
  drugVariantId: number;
  /** Loose goods, stocked in kilograms, weighed to three decimals. */
  looseProductId: number;
  looseVariantId: number;
  warehouseId: number;
  locationId: number;
  vendorId: number;
}

describe("[seeded-e2e] E3/E4 receiving seam", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  const setPacks = async (patch: Record<string, unknown>) => {
    await asTenant(() =>
      app.app.get(SettingsService).updateSettings(scene.orgId, scene.userId, patch),
    );
    return asTenant(() => app.app.get(SettingsService).getPacks(scene.orgId));
  };

  /** A sent order for `ordered` units of one variant, and its single line id. */
  async function sentOrder(variantId: number, ordered: number) {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-01",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          { productVariantId: variantId, quantity: ordered, unitCost: "10.0000", taxRate: "0", lineOrder: 0 },
        ],
      }),
    );
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, po.id, scene.userId));
    const [line] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${po.id}`),
    );
    return { poId: po.id, poLineId: line!.id };
  }

  /** Opens and posts a receipt in one claim — the real path a receiver takes. */
  const receive = (poId: number, line: Record<string, unknown>): Promise<unknown> =>
    asTenant(() =>
      app.app.get(GrnService).receiveGoods(scene.orgId, poId, scene.userId, `grn-${randomUUID()}`, {
        receivedDate: "2026-08-02",
        locationId: scene.locationId,
        lines: [line],
      } as never),
    );

  /**
   * Opens a receipt without posting it — the "count the pallet over an
   * afternoon" path. Separate from `receive` because the two answer different
   * questions: what a draft is allowed to be missing, and what a post is not.
   */
  const draft = (poId: number, line: Record<string, unknown>): Promise<{ id: number; status: string }> =>
    asTenant(() =>
      app.app.get(GrnService).createDraft(scene.orgId, scene.userId, `draft-${randomUUID()}`, {
        poId,
        receivedDate: "2026-08-02",
        locationId: scene.locationId,
        lines: [line],
      } as never),
    ) as Promise<{ id: number; status: string }>;

  const post = (grnId: number): Promise<number> =>
    asTenant(() =>
      app.app.get(GrnPostingService).postGrn(scene.orgId, grnId, scene.userId, `post-${randomUUID()}`),
    );

  /** The most recently written receipt line for a PO line. */
  const latestGrnLine = async (poLineId: number) => {
    const [row] = await asTenant(() =>
      db().execute<{ mrp_paise: string | null; purchase_rate_paise: string | null }>(sql`
        SELECT mrp_paise::text AS mrp_paise, purchase_rate_paise::text AS purchase_rate_paise
        FROM inv_grn_lines
        WHERE org_id = ${scene.orgId} AND po_line_id = ${poLineId}
        ORDER BY id DESC LIMIT 1`),
    );
    return row!;
  };

  /** The MRP the batch itself carries, as text. `null` when the batch is absent. */
  const lotMrp = async (lotNumber: string): Promise<string | null> => {
    const [row] = await asTenant(() =>
      db().execute<{ mrp_paise: string | null }>(sql`
        SELECT mrp_paise::text AS mrp_paise FROM inv_lots
        WHERE org_id = ${scene.orgId} AND lot_number = ${lotNumber}`),
    );
    return row ? row.mrp_paise : null;
  };

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

  const onHand = async (variantId: number): Promise<string> => {
    const [row] = await asTenant(() =>
      db().execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS total FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}`),
    );
    return row!.total;
  };

  const grnCount = async (poLineId: number): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM inv_grn_lines
        WHERE org_id = ${scene.orgId} AND po_line_id = ${poLineId}`),
    );
    return Number(row!.n);
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("receiver", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6).toUpperCase();
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["receiver"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;

      const kg = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Kilogram ${tag}`}, ${`KG${tag}`}, true) RETURNING id`);

      // Flagged from the start, so nothing in this suite depends on an update
      // path: the pack flag alone is what changes behaviour below.
      const drug = await one<{ id: number }>(sql`
        INSERT INTO inv_products
          (org_id, uom_id, name, sku, tracking_method, created_by, mrp_required, drug_schedule, mrp_paise)
        VALUES (${seeded.orgId}, ${kg.id}, 'Amoxil 250', ${`AMX-${tag}`}, 'LOT', ${userId},
                true, 'H1', ${MRP_PAISE})
        RETURNING id`);
      const drugVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${drug.id}, 'Default', ${`AMX-${tag}-V`}) RETURNING id`);

      const loose = await one<{ id: number }>(sql`
        INSERT INTO inv_products
          (org_id, uom_id, name, sku, tracking_method, created_by,
           sale_mode, quantity_input_mode, quantity_precision)
        VALUES (${seeded.orgId}, ${kg.id}, 'Loose rice', ${`RICE-${tag}`}, 'NONE', ${userId},
                'LOOSE', 'SCALE', 3)
        RETURNING id`);
      const looseVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${loose.id}, 'Default', ${`RICE-${tag}-V`}) RETURNING id`);

      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Dock', ${`DK${tag}`}, 'BIN', true) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Supplier', ${`VN${tag}`}, ${userId}) RETURNING id`);

      return {
        orgId: seeded.orgId,
        userId,
        drugProductId: drug.id,
        drugVariantId: drugVariant.id,
        looseProductId: loose.id,
        looseVariantId: looseVariant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        vendorId: vendor.id,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  describe("packs off — receiving must behave exactly as it did before", () => {
    it("posts a flagged SKU with no MRP, no batch and no expiry, and moves the stock", async () => {
      const { poId, poLineId } = await sentOrder(scene.drugVariantId, 50);
      await expect(
        receive(poId, { poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED" }),
      ).resolves.toBeDefined();

      // The SKU carries `mrp_required` and Schedule H1 in the catalogue already.
      // With the pack off none of that is consulted, and ten units land.
      expect(await onHand(scene.drugVariantId)).toBe("10.0000");
      const [row] = await asTenant(() =>
        db().execute<{ status: string; mrp_paise: string | null }>(sql`
          SELECT g.status, l.mrp_paise FROM inv_grn_lines l
          JOIN inv_grns g ON g.id = l.grn_id
          WHERE l.org_id = ${scene.orgId} AND l.po_line_id = ${poLineId}`),
      );
      expect(row!.status).toBe("POSTED");
      expect(row!.mrp_paise).toBeNull();
    });

    it("accepts a weighed quantity finer than the SKU's configured precision", async () => {
      const { poId, poLineId } = await sentOrder(scene.looseVariantId, 100);
      // Four decimals against a SKU configured for three. With the kirana pack
      // off there is no entry contract to honour, so it is received as typed.
      await expect(
        receive(poId, { poLineId, quantityReceived: "2.9955", qualityStatus: "ACCEPTED" }),
      ).resolves.toBeDefined();
      expect(await onHand(scene.looseVariantId)).toBe("2.9955");
    });
  });

  describe("pharmacy pack on — the receipt gate bites at post", () => {
    let poId: number;
    let poLineId: number;

    beforeAll(async () => {
      expect(await setPacks({ packPharmacy: true })).toMatchObject({ pharmacy: true });
      ({ poId, poLineId } = await sentOrder(scene.drugVariantId, 50));
    }, 120_000);

    it("refuses a receipt with no MRP, and moves nothing", async () => {
      const before = await onHand(scene.drugVariantId);
      await expect(
        refusalCode(() =>
          receive(poId, { poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED" }),
        ),
      ).resolves.toBe("MRP_REQUIRED");
      // The gate sits in the validation pass, before the quantity-received
      // writes and before the engine call, so a refusal leaves nothing behind.
      expect(await onHand(scene.drugVariantId)).toBe(before);
      expect(await grnCount(poLineId)).toBe(0);
    });

    it("refuses a batch-tracked receipt with no batch and with no expiry", async () => {
      await expect(
        refusalCode(() =>
          receive(poId, {
            poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED",
            mrpPaise: MRP_PAISE,
          }),
        ),
      ).resolves.toBe("LOT_REQUIRED");
      await expect(
        refusalCode(() =>
          receive(poId, {
            poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED",
            mrpPaise: MRP_PAISE, lotNumber: "B-2409",
          }),
        ),
      ).resolves.toBe("EXPIRY_REQUIRED");
      expect(await grnCount(poLineId)).toBe(0);
    });

    it("refuses a purchase rate above the printed MRP", async () => {
      await expect(
        refusalCode(() =>
          receive(poId, {
            poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED",
            mrpPaise: MRP_PAISE, purchaseRatePaise: 13_000,
            lotNumber: "B-2409", expiryDate: "2027-03-31",
          }),
        ),
      ).resolves.toBe("PURCHASE_RATE_ABOVE_MRP");
    });

    it("posts a complete line and snapshots the MRP onto the line and the batch", async () => {
      const before = await onHand(scene.drugVariantId);
      await expect(
        receive(poId, {
          poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED",
          mrpPaise: MRP_PAISE, purchaseRatePaise: PURCHASE_RATE_PAISE,
          lotNumber: "B-2409", expiryDate: "2027-03-31",
        }),
      ).resolves.toBeDefined();

      // 10 more on top of the 10 the packs-off block received.
      expect(before).toBe("10.0000");
      expect(await onHand(scene.drugVariantId)).toBe("20.0000");

      const [line] = await asTenant(() =>
        db().execute<{ mrp_paise: string; purchase_rate_paise: string }>(sql`
          SELECT mrp_paise::text, purchase_rate_paise::text FROM inv_grn_lines
          WHERE org_id = ${scene.orgId} AND po_line_id = ${poLineId}`),
      );
      expect(line!.mrp_paise).toBe(String(MRP_PAISE));
      expect(line!.purchase_rate_paise).toBe(String(PURCHASE_RATE_PAISE));

      // The snapshot that matters: the batch on the shelf carries the ceiling
      // printed on its own packs, not whatever the catalogue says next quarter.
      const [lot] = await asTenant(() =>
        db().execute<{ mrp_paise: string; expiry_date: string }>(sql`
          SELECT mrp_paise::text, expiry_date::text FROM inv_lots
          WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.drugVariantId}
            AND lot_number = 'B-2409'`),
      );
      expect(lot!.mrp_paise).toBe(String(MRP_PAISE));
      expect(lot!.expiry_date).toBe("2027-03-31");
    });

    it("keeps the batch's MRP when a later delivery of it prints a new one", async () => {
      // The manufacturer reprints at ₹130.00 and the next delivery of B-2409
      // says so. The packs already on the shelf still say ₹125.50, and those are
      // the ones in the customer's hand — so the batch keeps what it was
      // received with. Both snapshots are write-once; a reprint that matters
      // arrives as a new batch number, and `inv_products.mrp_paise` is the
      // catalogue default that moves, not the ceiling that binds a counter.
      await expect(
        receive(poId, {
          poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED",
          mrpPaise: 13_000, purchaseRatePaise: PURCHASE_RATE_PAISE,
          lotNumber: "B-2409", expiryDate: "2027-03-31",
        }),
      ).resolves.toBeDefined();

      // The line records what this delivery's cartons said...
      expect(await latestGrnLine(poLineId)).toMatchObject({ mrp_paise: "13000" });
      // ...and the batch still says what the first delivery's cartons said.
      expect(await lotMrp("B-2409")).toBe("12550");
      // 10 from the packs-off block, 10 from the complete line, 10 now.
      expect(await onHand(scene.drugVariantId)).toBe("30.0000");
    });

    it("lets a draft be half-written and refuses at the post, not at the door", async () => {
      // Counting is not posting. A receipt is allowed to be incomplete while it
      // is being written — that is what DRAFT is for — and the refusal belongs
      // at the moment the goods become stock, where the whole delivery is judged
      // at once rather than line by line at the dock door.
      const opened = await draft(poId, {
        poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED",
        lotNumber: "B-2501", expiryDate: "2027-09-30",
      });
      expect(opened.status).toBe("DRAFT");
      expect(await latestGrnLine(poLineId)).toMatchObject({ mrp_paise: null });

      await expect(refusalCode(() => post(opened.id))).resolves.toBe("MRP_REQUIRED");

      // Still a draft, and no batch was opened: the refusal cost the counter
      // nothing and left nothing half-posted behind it.
      const [after] = await asTenant(() =>
        db().execute<{ status: string }>(sql`
          SELECT status FROM inv_grns WHERE org_id = ${scene.orgId} AND id = ${opened.id}`),
      );
      expect(after!.status).toBe("DRAFT");
      expect(await lotMrp("B-2501")).toBeNull();
      expect(await onHand(scene.drugVariantId)).toBe("30.0000");
    });
  });

  describe("kirana pack on — the entry contract bites before the conversion", () => {
    beforeAll(async () => {
      expect(await setPacks({ packKirana: true })).toMatchObject({ kirana: true });
    }, 120_000);

    it("refuses a weighed quantity finer than the SKU's precision, and writes no receipt", async () => {
      const { poId, poLineId } = await sentOrder(scene.looseVariantId, 100);
      const before = await onHand(scene.looseVariantId);
      await expect(
        refusalCode(() =>
          receive(poId, { poLineId, quantityReceived: "2.9955", qualityStatus: "ACCEPTED" }),
        ),
      ).resolves.toBe("QUANTITY_PRECISION_EXCEEDED");
      expect(await grnCount(poLineId)).toBe(0);
      expect(await onHand(scene.looseVariantId)).toBe(before);
    });

    it("accepts the same reading at the SKU's own precision", async () => {
      const { poId, poLineId } = await sentOrder(scene.looseVariantId, 100);
      await expect(
        receive(poId, { poLineId, quantityReceived: "2.995", qualityStatus: "ACCEPTED" }),
      ).resolves.toBeDefined();
      // 2.9955 from the packs-off block plus 2.995 now.
      expect(await onHand(scene.looseVariantId)).toBe("5.9905");
    });

    it("refuses a fraction of a SKU that carries no capture columns at all", async () => {
      // The drug was never configured for measured entry, so with the kirana
      // pack on it falls to the default contract: packed goods, whole units, no
      // decimal places. Half a carton is not a quantity it can be received in —
      // and the entry gate answers first, before the pharmacy gate at post ever
      // sees the line, which is why the code is a quantity one despite the MRP
      // being present and correct.
      const { poId, poLineId } = await sentOrder(scene.drugVariantId, 50);
      await expect(
        refusalCode(() =>
          receive(poId, {
            poLineId, quantityReceived: "2.5", qualityStatus: "ACCEPTED",
            mrpPaise: MRP_PAISE, lotNumber: "B-2601", expiryDate: "2027-03-31",
          }),
        ),
      ).resolves.toBe("QUANTITY_MUST_BE_WHOLE");
      expect(await grnCount(poLineId)).toBe(0);
    });
  });
});
