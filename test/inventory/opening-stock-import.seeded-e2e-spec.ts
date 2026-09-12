import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { ImportService } from "src/modules/inventory/import-export/import.service";
import { StagedImportService } from "src/modules/inventory/import-export/staged-import.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-37 — what the opening-stock importer actually posts.
 *
 * `resumable-import.seeded-e2e-spec.ts` proves the staging, claiming,
 * checkpointing and retry half of INV-37, and says so in its own docstring:
 * "the applier here is deliberately trivial", rows are `uom` type, "no stock
 * movement". So the ticket's other half — *grain-preserving stock posts* — had
 * never been executed by anything. `csv-validation.spec.ts` is a mocked unit
 * test of row validation and never reaches the engine either.
 *
 * Three things were wrong underneath that gap, and each is a test below.
 *
 *   1. `EXPECTED_COLUMNS["opening-stock"]` advertises `lotNumber` and
 *      `serialNumber`, `previewImport` reports them as mapped, and
 *      `processOpeningStockRow` read neither. Every row posted at the loose,
 *      lot-less, serial-less, OWNED grain. Loading a lot-tracked warehouse's
 *      opening balances put every batch on one anonymous row — the grain
 *      collapse §4.2 of the pack calls corruption, arriving through the one
 *      door whose whole purpose is bulk.
 *
 *   2. Quantity and unit cost went through `parseFloat`. `parseFloat` stops at
 *      the first character it cannot read and returns what it has, so the
 *      thousands separator a spreadsheet writes by default turns 1,000 units
 *      into 1 — no error, no warning, a row marked APPLIED.
 *
 *   3. A serial number identifies one physical unit. Nothing said so, so a row
 *      naming a serial with a quantity of 40 was postable.
 *
 * Grain that the CSV has no column for — handling unit, ownership — is loose
 * and OWNED, and that is not a collapse: an opening balance is this
 * organisation's own stock sitting on a shelf. The assertions below say so
 * explicitly rather than leaving it to be inferred from silence.
 *
 *   pnpm test:e2e:seeded --testPathPattern=opening-stock-import
 */

const PERMISSIONS = [
  "inventory:import",
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
];

interface Scene {
  orgId: string;
  userId: string;
  lotVariantId: number;
  serialVariantId: number;
  locationId: number;
  locationCode: string;
  lotSku: string;
  serialSku: string;
}

type LevelRow = {
  lot_id: number | null;
  serial_id: number | null;
  handling_unit_id: number | null;
  ownership: string;
  on_hand: string;
};

describe("[seeded-e2e] INV-37 — opening stock imported at its own grain", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let tag: string;

  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  /**
   * One file, staged and processed the way the controller does it: create the
   * job, stage the rows, then process until the job says it is finished.
   */
  async function importRows(
    rows: ReadonlyArray<Record<string, string>>,
    key = `opening-${randomUUID().slice(0, 8)}`,
  ) {
    const job = await asTenant(() =>
      app.app.get(StagedImportService).createJob(scene.orgId, scene.userId, {
        importType: "opening-stock",
        fileName: "opening.csv",
        totalRows: rows.length,
        checksum: `sha256:${key}`,
        idempotencyKey: key,
        chunkSize: 100,
      }),
    );
    await asTenant(() =>
      app.app.get(StagedImportService).stageRows(
        scene.orgId,
        job.id,
        rows.map((payload, i) => ({ rowNumber: i + 1, payload })),
      ),
    );

    let progress = await asTenant(() =>
      app.app.get(ImportService).processStagedChunk(scene.orgId, scene.userId, job.id),
    );
    let guard = 0;
    while (!progress.finished) {
      progress = await asTenant(() =>
        app.app.get(ImportService).processStagedChunk(scene.orgId, scene.userId, job.id),
      );
      if (++guard > 20) throw new Error("import did not converge");
    }

    const errors = await asTenant(() =>
      app.app.get(StagedImportService).errors(scene.orgId, job.id, 1, 50),
    );
    return { jobId: job.id, progress, errors };
  }

  /** Every stock row this variant stands on, at the full natural key. */
  const levelsOf = (variantId: number): Promise<LevelRow[]> =>
    asTenant(async () =>
      db().execute<LevelRow>(sql`
        SELECT lot_id, serial_id, handling_unit_id, ownership, on_hand::text AS on_hand
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}
         ORDER BY id`),
    );

  const lotNumberOf = (lotId: number | null): Promise<string | null> =>
    asTenant(async () => {
      if (lotId === null) return null;
      const rows = await db().execute<{ lot_number: string }>(sql`
        SELECT lot_number FROM inv_lots
         WHERE org_id = ${scene.orgId} AND id = ${lotId}`);
      return rows[0]?.lot_number ?? null;
    });

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("loader", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members["loader"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Opening', ${`OP${tag}`}, ${userId}) RETURNING id`);
      const locationCode = `OB${tag}`;
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Opening bin', ${locationCode}, 'BIN') RETURNING id`);

      async function variant(sku: string, tracking: string): Promise<number> {
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
          VALUES (${seeded.orgId}, ${uom.id}, ${sku}, ${sku}, ${sql.raw(`'${tracking}'`)}, ${userId})
          RETURNING id`);
        const row = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`${sku}-V1`}) RETURNING id`);
        return row.id;
      }

      const lotSku = `OPEN-LOT-${tag}`;
      const serialSku = `OPEN-SER-${tag}`;
      return {
        orgId: seeded.orgId,
        userId,
        lotVariantId: await variant(lotSku, "LOT"),
        serialVariantId: await variant(serialSku, "SERIAL"),
        locationId: location.id,
        locationCode,
        lotSku,
        serialSku,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  describe("the batch the file named", () => {
    it("posts a lot-tracked opening balance onto that lot, not onto the loose row", async () => {
      const { progress, errors } = await importRows([
        {
          sku: scene.lotSku,
          locationCode: scene.locationCode,
          quantity: "40.0000",
          unitCost: "2.5000",
          lotNumber: `BATCH-A-${tag}`,
        },
      ]);

      // The failure message first: a row error here says why, and the grain
      // assertion below would otherwise report an empty table.
      expect(errors.items).toEqual([]);
      expect(progress.appliedRows).toBe(1);

      const levels = await levelsOf(scene.lotVariantId);
      expect(levels).toHaveLength(1);
      expect(levels[0]!.on_hand).toBe("40.0000");
      // The defect: `lot_id` was null, so this batch and every later one shared
      // one anonymous row and no recall could ever name them apart.
      expect(levels[0]!.lot_id).not.toBeNull();
      expect(await lotNumberOf(levels[0]!.lot_id)).toBe(`BATCH-A-${tag}`);
    }, 300_000);

    it("keeps two batches of one SKU on two rows", async () => {
      // The half that makes the assertion above mean something. A file naming
      // two batches must not merge them: the collapse is only visible once a
      // second batch arrives, and merging is what a lot-less post looks like
      // from the outside.
      const { errors } = await importRows([
        {
          sku: scene.lotSku,
          locationCode: scene.locationCode,
          quantity: "15.0000",
          lotNumber: `BATCH-B-${tag}`,
        },
      ]);
      expect(errors.items).toEqual([]);

      const levels = await levelsOf(scene.lotVariantId);
      expect(levels).toHaveLength(2);
      expect(levels.map((l) => l.on_hand).sort()).toEqual(["15.0000", "40.0000"]);
      const numbers = await Promise.all(levels.map((l) => lotNumberOf(l.lot_id)));
      expect(numbers.sort()).toEqual([`BATCH-A-${tag}`, `BATCH-B-${tag}`]);
    }, 300_000);

    it("leaves the grain the file has no column for loose and owned", async () => {
      // Not an oversight: an opening balance is this organisation's own stock
      // on a shelf, so OWNED and no handling unit are the right answers rather
      // than absent ones. Stated here so a future column cannot quietly change
      // it.
      const levels = await levelsOf(scene.lotVariantId);
      expect(levels.every((l) => l.handling_unit_id === null)).toBe(true);
      expect(levels.every((l) => l.ownership === "OWNED")).toBe(true);
    });
  });

  describe("the unit the file named", () => {
    it("posts a serial onto its own unit and brings that serial into stock", async () => {
      const serialNumber = `SN-${tag}-0001`;
      const { errors } = await importRows([
        {
          sku: scene.serialSku,
          locationCode: scene.locationCode,
          quantity: "1.0000",
          serialNumber,
        },
      ]);
      expect(errors.items).toEqual([]);

      const levels = await levelsOf(scene.serialVariantId);
      expect(levels).toHaveLength(1);
      expect(levels[0]!.serial_id).not.toBeNull();

      const serials = await asTenant(() =>
        db().execute<{ id: number; status: string; current_location_id: number }>(sql`
          SELECT id, status, current_location_id FROM inv_serial_numbers
           WHERE org_id = ${scene.orgId} AND serial_number = ${serialNumber}`),
      );
      expect(serials).toHaveLength(1);
      expect(serials[0]!.id).toBe(levels[0]!.serial_id);
      expect(serials[0]!.status).toBe("IN_STOCK");
      expect(serials[0]!.current_location_id).toBe(scene.locationId);
    }, 300_000);

    it("refuses a serial standing for more than one unit", async () => {
      // A serial number is one physical thing. Forty of them under one number
      // is not a quantity, it is a file that meant something else.
      const before = await levelsOf(scene.serialVariantId);
      const { progress, errors } = await importRows([
        {
          sku: scene.serialSku,
          locationCode: scene.locationCode,
          quantity: "40.0000",
          serialNumber: `SN-${tag}-BULK`,
        },
      ]);

      expect(progress.appliedRows).toBe(0);
      expect(progress.failedRows).toBe(1);
      expect(errors.items[0]).toMatchObject({ rowNumber: 1, field: "serialNumber" });
      // And the refusal did not post on its way out.
      expect(await levelsOf(scene.serialVariantId)).toEqual(before);
    }, 300_000);
  });

  describe("the quantity the file wrote", () => {
    it("refuses a thousands separator rather than importing one unit", async () => {
      // `parseFloat("1,000")` is 1. A spreadsheet writes that separator by
      // default, so the file that meant a thousand units imported one, marked
      // the row APPLIED, and left nobody a reason to look.
      const before = await levelsOf(scene.lotVariantId);
      const { progress, errors } = await importRows([
        {
          sku: scene.lotSku,
          locationCode: scene.locationCode,
          quantity: "1,000",
          lotNumber: `BATCH-C-${tag}`,
        },
      ]);

      expect(progress.appliedRows).toBe(0);
      expect(errors.items[0]).toMatchObject({ rowNumber: 1, field: "quantity" });
      expect(await levelsOf(scene.lotVariantId)).toEqual(before);
    }, 300_000);

    it("refuses a quantity with a unit typed after it", async () => {
      // The same defect with a friendlier face: `parseFloat("12 cases")` is 12,
      // and twelve cases is not twelve units.
      const { progress, errors } = await importRows([
        {
          sku: scene.lotSku,
          locationCode: scene.locationCode,
          quantity: "12 cases",
          lotNumber: `BATCH-D-${tag}`,
        },
      ]);
      expect(progress.appliedRows).toBe(0);
      expect(errors.items[0]).toMatchObject({ rowNumber: 1, field: "quantity" });
    }, 300_000);

    it("carries a four-decimal quantity through exactly", async () => {
      // The control for the two refusals above: a well-formed decimal is not
      // refused, and it arrives as written rather than as a float's opinion of
      // it.
      const { errors } = await importRows([
        {
          sku: scene.lotSku,
          locationCode: scene.locationCode,
          quantity: "1234.5678",
          unitCost: "1.2500",
          lotNumber: `BATCH-E-${tag}`,
        },
      ]);
      expect(errors.items).toEqual([]);

      const levels = await levelsOf(scene.lotVariantId);
      const numbers = await Promise.all(levels.map((l) => lotNumberOf(l.lot_id)));
      const landed = levels[numbers.indexOf(`BATCH-E-${tag}`)];
      expect(landed).toBeDefined();
      expect(landed!.on_hand).toBe("1234.5678");
    }, 300_000);
  });

  describe("running the same file again", () => {
    it("applies nothing twice", async () => {
      // INV-37's acceptance in one line. The row status is the guard and the
      // engine's own key is the fence behind it; this proves the pair rather
      // than either alone.
      const key = `opening-replay-${randomUUID().slice(0, 8)}`;
      const rows = [
        {
          sku: scene.lotSku,
          locationCode: scene.locationCode,
          quantity: "7.0000",
          lotNumber: `BATCH-R-${tag}`,
        },
      ];

      const first = await importRows(rows, key);
      expect(first.errors.items).toEqual([]);
      const after = await levelsOf(scene.lotVariantId);

      // Re-opening under the same key returns the same job rather than a second
      // one — the importer's own fence, and the reason a retried upload cannot
      // become two imports.
      const reopened = await asTenant(() =>
        app.app.get(StagedImportService).createJob(scene.orgId, scene.userId, {
          importType: "opening-stock",
          totalRows: rows.length,
          checksum: `sha256:${key}`,
          idempotencyKey: key,
        }),
      );
      expect(reopened.id).toBe(first.jobId);

      // And processing it again finds nothing PENDING, so no row applies twice.
      const replay = await asTenant(() =>
        app.app.get(ImportService).processStagedChunk(scene.orgId, scene.userId, first.jobId),
      );
      expect(replay.appliedRows).toBe(rows.length);
      expect(await levelsOf(scene.lotVariantId)).toEqual(after);

      const ledger = await asTenant(() =>
        db().execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_stock_transactions
           WHERE org_id = ${scene.orgId}
             AND reference_type = 'IMPORT'
             AND reference_id = ${String(first.jobId)}`),
      );
      expect(ledger[0]!.n).toBe(rows.length);
    }, 300_000);
  });
});
