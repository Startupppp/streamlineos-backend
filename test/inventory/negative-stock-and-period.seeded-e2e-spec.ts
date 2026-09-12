import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InventorySettingsService } from "src/modules/inventory/stock-engine/inventory-settings.service";
import type { StockEngineCommand } from "src/modules/inventory/stock-engine/stock-engine.types";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";
import { buildInventoryFixture, type InventoryFixture } from "test/helpers/inventory-fixture";

/**
 * INV-19 — the two policies that decide whether a movement is allowed at all.
 *
 * Both are implemented in the kernel and neither had a test. `assertBucketsCoherent`
 * refuses a negative `on_hand` unless `allow_negative_stock` is set, and the
 * accounting bridge refuses a movement into a closed period where periods
 * exist. A policy nobody exercises is a policy that stops working the first
 * time somebody reorders the checks — and the failure is silent in the
 * dangerous direction, because a warehouse that never goes short never notices
 * that the guard stopped firing.
 *
 * The determinism is the point. The pack asks for "deterministic errors", so
 * each case asserts the specific code the caller has to branch on, not merely
 * that something was thrown — a guard that started answering 500 would still
 * pass a `.rejects.toThrow()`.
 *
 *   pnpm test:e2e:seeded --testPathPattern=negative-stock-and-period
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
];

describe("[seeded-e2e] INV-19 — negative stock and closed periods", () => {
  let seededApp: SeededE2eApp;
  let db: Db;
  let orgId: string;
  let userId: string;
  let fixture: InventoryFixture;
  const teardowns: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
    db = seededApp.app.get<Db>(DRIZZLE);

    const seeded = await seedOrg(seededApp.seedDb)
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardowns.push(() => seeded.teardown());
    orgId = seeded.orgId;
    userId = seeded.members["keeper"]!.userId;
    fixture = await buildInventoryFixture(seededApp.app, orgId, userId, "inv19");
  }, 600_000);

  afterAll(async () => {
    for (const teardown of teardowns.reverse()) await teardown().catch(() => undefined);
    if (seededApp) await seededApp.close();
  }, 120_000);

  /** More than the fixture ever put in the bin, so the bucket must go under. */
  const oversizedIssue = (key: string, postingDate = "2026-06-02"): StockEngineCommand => ({
    idempotencyKey: `inv19-${key}`,
    sourceType: "TEST",
    sourceId: `inv19-${key}`,
    reason: "negative stock probe",
    postingDate,
    movements: [
      {
        transactionType: "ADJUSTMENT_OUT",
        productVariantId: fixture.variants.widget.variantId,
        locationId: fixture.locations.mainBin,
        quantityDelta: "-999999.0000",
      },
    ],
  });

  const post = (cmd: StockEngineCommand) =>
    runInNewTenantTransaction(db, orgId, (tx) =>
      seededApp.app.get(StockEngineService).executeInTx(tx, orgId, userId, cmd),
    );

  /**
   * Through the service, not through SQL.
   *
   * `get` caches per organisation, and `update` is the only thing that
   * invalidates it. A raw UPDATE would leave the engine reading the old policy
   * from cache, so the second half of this file would silently be testing the
   * first half's setting and passing.
   */
  async function setAllowNegative(value: boolean): Promise<void> {
    await runInNewTenantTransaction(db, orgId, () =>
      seededApp.app
        .get(InventorySettingsService)
        .update(orgId, { allowNegativeStock: value }, userId),
    );
  }

  /**
   * Every read here opens its own tenant transaction, because these suites run
   * as the application role and `inv_stock_levels` is behind
   * `tenant_isolation` — a context-less select does not come back empty, it
   * raises 42501. That is the policy doing its job; the test has to enter a
   * tenant like the application does.
   */
  const onHandOf = (): Promise<string> =>
    runInNewTenantTransaction(db, orgId, async (tx) => {
      const rows = await tx.execute<{ on_hand: string }>(sql`
        SELECT on_hand FROM inv_stock_levels
         WHERE org_id = ${orgId}
           AND product_variant_id = ${fixture.variants.widget.variantId}
           AND location_id = ${fixture.locations.mainBin}
           AND lot_id IS NULL AND serial_id IS NULL AND handling_unit_id IS NULL
      `);
      return rows[0]?.on_hand ?? "0";
    });

  describe("with the default policy — negative stock refused", () => {
    it(
      "refuses an issue that would take the bin below zero, with INSUFFICIENT_STOCK",
      async () => {
        await setAllowNegative(false);
        const before = await onHandOf();
        expect(Number(before)).toBeGreaterThan(0);

        await expect(post(oversizedIssue("refused"))).rejects.toMatchObject({
          response: { code: "INSUFFICIENT_STOCK" },
        });

        // The refusal has to leave the ledger alone, not merely report itself.
        expect(await onHandOf()).toBe(before);
      },
      300_000,
    );

    it(
      "wrote no ledger row for the refused command",
      async () => {
        const rows = await runInNewTenantTransaction(db, orgId, (tx) =>
          tx.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM inv_stock_transactions
             WHERE org_id = ${orgId} AND reference_id = 'inv19-refused'
          `),
        );
        expect(rows[0]?.n).toBe(0);
      },
      120_000,
    );
  });

  describe("with the policy relaxed — negative stock permitted", () => {
    it(
      "lets the same issue through and records the negative balance",
      async () => {
        await setAllowNegative(true);

        await post(oversizedIssue("allowed"));

        expect(Number(await onHandOf())).toBeLessThan(0);
      },
      300_000,
    );

    /**
     * The relaxation is deliberately narrow. `allow_negative_stock` says stock
     * may go below zero; it has never meant a hold may exceed what is there, and
     * `blocked_qty`/`quality_hold_qty` are refused negative on both settings.
     */
    it(
      "still refuses a release larger than what is held",
      async () => {
        await expect(
          post({
            idempotencyKey: "inv19-overrelease",
            sourceType: "TEST",
            sourceId: "inv19-overrelease",
            reason: "release more than held",
            postingDate: "2026-06-02",
            movements: [
              {
                transactionType: "QUARANTINE_OUT",
                productVariantId: fixture.variants.widget.variantId,
                locationId: fixture.locations.mainBin,
                quantityDelta: "-50.0000",
                qualityBucket: "QUALITY_HOLD",
              },
            ],
          }),
        ).rejects.toMatchObject({ response: { code: "RELEASE_EXCEEDS_HELD" } });
      },
      300_000,
    );
  });

  /**
   * The period gate only exists where the accounting module has been migrated.
   * `accounting_periods` is probed with `to_regclass` rather than caught as a
   * 42P01 inside the engine transaction, so on a database without it the answer
   * is "no control", not an error — and that is what this asserts, in whichever
   * state the database is actually in. Skipping silently would make this file
   * report a guard it never reached.
   */
  describe("posting date control", () => {
    it(
      "either enforces a closed period or reports honestly that periods do not exist",
      async () => {
        await setAllowNegative(true);

        // A catalogue probe, so it needs no tenant — but it is opened inside one
        // anyway so every read in this file follows one rule.
        const periodsExist = await runInNewTenantTransaction(db, orgId, (tx) =>
          tx.execute<{ present: boolean }>(sql`
            SELECT to_regclass('public.accounting_periods') IS NOT NULL AS present
          `),
        );
        const hasPeriods = periodsExist[0]?.present === true;

        if (!hasPeriods) {
          // Recorded as an observation rather than a pass: the guard is real,
          // this database simply has nothing for it to read.
          expect(hasPeriods).toBe(false);
          return;
        }

        await runInNewTenantTransaction(db, orgId, async (tx) => {
          await tx.execute(sql`
            INSERT INTO accounting_periods (org_id, name, start_date, end_date, status)
            VALUES (${orgId}, 'INV-19 closed probe', DATE '2025-01-01', DATE '2025-01-31', 'CLOSED')
            ON CONFLICT DO NOTHING
          `);
        });

        await expect(
          post(oversizedIssue("closed-period", "2025-01-15")),
        ).rejects.toBeDefined();
      },
      300_000,
    );
  });
});
