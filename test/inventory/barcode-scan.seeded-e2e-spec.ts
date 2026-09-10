import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { InvBarcodeService } from "src/modules/inventory/barcode/inv-barcode.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/** FNC1 as a wedge transmits it. */
const GS = "\x1D";

/**
 * INV-203 — resolving a scan against real records.
 *
 * The parser is unit-tested; what needs a database is the half that can look
 * entirely successful while being wrong. A batch label scanned onto the wrong
 * product resolves to a real lot and a real variant, and only comparing them
 * shows they are not about the same goods.
 */
describe("[seeded-e2e] barcode scan resolution", () => {
  let app: SeededE2eApp;
  let orgId = "";
  let userId = "";
  let gtin = "";
  let variantId = 0;
  let otherVariantId = 0;
  let teardown: () => Promise<void>;

  const scan = (payload: string) =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), orgId, () =>
      app.app.get(InvBarcodeService).scan(orgId, userId, payload),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("scanner", { permissionKeys: ["inventory:stock:read"] })
      .build();
    teardown = () => seeded.teardown();
    orgId = seeded.orgId;
    userId = seeded.members["scanner"]!.userId;

    const tag = randomUUID().slice(0, 6);
    gtin = `0950600${tag.replace(/\D/g, "0").padEnd(7, "0")}`.slice(0, 14).padEnd(14, "0");
    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, orgId, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${orgId}, ${uom.id}, 'Scanned goods', ${`SC-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku, barcode)
        VALUES (${orgId}, ${product.id}, 'Default', ${`SC-${tag}-V`}, ${gtin}) RETURNING id`);
      const other = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${orgId}, ${product.id}, 'Other', ${`SC-${tag}-V2`}) RETURNING id`);
      variantId = variant.id;
      otherVariantId = other.id;

      await db.execute(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status, expiry_date)
        VALUES (${orgId}, ${variant.id}, ${`LOT-${tag}`}, 'ACTIVE', '2027-03-31')`);
      await db.execute(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status)
        VALUES (${orgId}, ${other.id}, ${`FOREIGN-${tag}`}, 'ACTIVE')`);
    });

    scanTag = tag;
  }, 240_000);

  let scanTag = "";

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("resolves a GTIN and its batch from one element string", async () => {
    const result = await scan(`01${gtin}10LOT-${scanTag}`);
    expect(result.parsed.isGs1).toBe(true);
    expect(result.variant?.id).toBe(variantId);
    expect(result.lot?.lotNumber).toBe(`LOT-${scanTag}`);
    expect(result.warnings).toEqual([]);
  });

  it("notices when the batch belongs to a different variant than the GTIN", async () => {
    // Both halves resolve. Reading either alone looks like a clean scan, and a
    // stock command built from it would attribute goods to the wrong product.
    const result = await scan(`01${gtin}10FOREIGN-${scanTag}`);
    expect(result.variant?.id).toBe(variantId);
    expect(result.lot?.productVariantId).toBe(otherVariantId);
    expect(result.warnings.join(" ")).toMatch(/different variant/);
  });

  it("notices when the printed expiry disagrees with the record", async () => {
    // A reprinted label must not be able to extend shelf life by assertion.
    const result = await scan(`01${gtin}17270101${GS}10LOT-${scanTag}`);
    expect(result.warnings.join(" ")).toMatch(/does not match recorded expiry/);
  });

  it("agrees silently when the printed expiry matches", async () => {
    // The control: without it the warning above would also pass against code
    // that complained about every label it read.
    const result = await scan(`01${gtin}17270331${GS}10LOT-${scanTag}`);
    expect(result.warnings.join(" ")).not.toMatch(/expiry/);
  });

  it("says so when a GTIN is on no variant", async () => {
    const result = await scan("0100000000000017");
    expect(result.variant ?? null).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/No product variant carries GTIN/);
  });

  describe("capturing a scan as a fact", () => {
    const capturedFacts = (key: string) =>
      runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), orgId, async () =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM outbox_events
          WHERE organization_id = ${orgId}
            AND event_type = 'inventory.scan.captured'
            AND aggregate_id = ${key}`),
      );

    const capture = (key: string, payload: string) =>
      runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), orgId, () =>
        app.app.get(InvBarcodeService).captureScan(orgId, userId, key, payload),
      );

    it("emits exactly one fact for one capture", async () => {
      const key = `scan-${randomUUID()}`;
      const result = await capture(key, `01${gtin}10LOT-${scanTag}`);

      expect(result.captured).toBe(true);
      expect(result.variant?.id).toBe(variantId);
      expect((await capturedFacts(key))[0]!.n).toBe(1);
    });

    it("emits no second fact when the device retries the same scan", async () => {
      // A scanner on a failing network sends the same scan several times.
      // Three facts for one physical event corrupt a throughput count as surely
      // as none would.
      const key = `scan-${randomUUID()}`;
      const payload = `01${gtin}10LOT-${scanTag}`;
      const first = await capture(key, payload);
      const second = await capture(key, payload);

      expect(first.captured).toBe(true);
      expect(second.captured).toBe(false);
      expect((await capturedFacts(key))[0]!.n).toBe(1);
    });

    it("emits a separate fact for a genuinely separate scan", async () => {
      // The control: without it the retry rule above would also pass against an
      // implementation that recorded the first scan and nothing ever again.
      const keyA = `scan-${randomUUID()}`;
      const keyB = `scan-${randomUUID()}`;
      await capture(keyA, `01${gtin}10LOT-${scanTag}`);
      await capture(keyB, `01${gtin}10LOT-${scanTag}`);

      expect((await capturedFacts(keyA))[0]!.n).toBe(1);
      expect((await capturedFacts(keyB))[0]!.n).toBe(1);
    });

    it("records the raw payload, not only what it was taken to mean", async () => {
      // An interpretation can later be shown to be wrong; what the scanner read
      // cannot.
      const key = `scan-${randomUUID()}`;
      const payload = `01${gtin}10LOT-${scanTag}`;
      await capture(key, payload);

      const [row] = await runInNewTenantTransaction(
        app.app.get<Db>(DRIZZLE),
        orgId,
        async () =>
          app.app.get<Db>(DRIZZLE).execute<{ payload: { raw: string } }>(sql`
            SELECT payload FROM outbox_events
            WHERE organization_id = ${orgId} AND aggregate_id = ${key}`),
      );
      expect(row!.payload.raw).toBe(payload);
    });
  });

  it("falls through to the plain lookup for an ordinary barcode", async () => {
    // Most scans are not GS1, and a wedge reading a bin label must keep working.
    const result = await scan(`SC-${scanTag}-V`);
    expect(result.parsed.isGs1).toBe(false);
    expect(result.lookup?.type).toBe("variant");
  });
});
