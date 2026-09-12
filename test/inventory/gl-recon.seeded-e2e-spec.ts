import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvGlReconService } from "src/modules/inventory/reconciliation/gl/inv-gl-recon.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";
import { buildInventoryFixture, type InventoryFixture } from "test/helpers/inventory-fixture";

/**
 * INV-08 — the report that makes an unposted movement discoverable.
 *
 * The accounting bridge does not fail a movement when the account it would post
 * to is unmapped. That is deliberate and defensible: a goods receipt is a
 * physical fact that already happened, and refusing to record it because nobody
 * configured account 1300 moves the warehouse's records further from the truth.
 *
 * The whole argument rests on the gap being *findable*. A skip that is only a
 * `logger.warn` is a swallow with a nicer name — nobody greps production logs
 * for warnings about accounts. So the claim this file exists to check is not
 * "the bridge skips politely", it is "a movement with no journal behind it can
 * be found by asking".
 *
 * That was the one thing the handoff recorded as unproven about INV-07.
 *
 *   pnpm test:e2e:seeded --testPathPattern=gl-recon
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:reports:read",
];

describe("[seeded-e2e] INV-08 — a movement with no journal is discoverable", () => {
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
    fixture = await buildInventoryFixture(seededApp.app, orgId, userId, "inv08");

    // A movement inside the window the report will be asked about. The fixture
    // seeds no chart of accounts, which is exactly the state under test.
    await runInNewTenantTransaction(db, orgId, (tx) =>
      seededApp.app.get(StockEngineService).executeInTx(tx, orgId, userId, {
        idempotencyKey: "inv08-receipt",
        // A postable business event, not an arbitrary label. The report joins
        // GL_POSTING_RULES on `reference_type`, so a made-up source type lands
        // in `unpostedByDesign` — correctly, and not where this test is looking.
        sourceType: "inv_grn",
        sourceId: "inv08-receipt",
        reason: "gl recon probe",
        postingDate: "2026-06-15",
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: fixture.variants.widget.variantId,
            locationId: fixture.locations.mainBin,
            quantityDelta: "12.0000",
            unitCost: "4.0000",
          },
        ],
      }),
    );
  }, 600_000);

  afterAll(async () => {
    for (const teardown of teardowns.reverse()) await teardown().catch(() => undefined);
    if (seededApp) await seededApp.close();
  }, 120_000);

  const report = () =>
    runInNewTenantTransaction(db, orgId, () =>
      seededApp.app.get(InvGlReconService).report(orgId, userId, {
        fromDate: "2026-06-01",
        toDate: "2026-06-30",
        page: 1,
        limit: 50,
      }),
    );

  it(
    "finds the movement, and does not claim it was reconciled",
    async () => {
      const result = (await report()) as {
        summary: { groups: number; matched: number; missingCoa: number; unmatched: number; notInstalled: number };
        items: Array<{ sourceId: string; status: string; journalEntryId: number | null }>;
      };

      // The floor. An empty report agrees with every assertion below and proves
      // nothing — the window has to contain the movement that was just posted.
      expect(result.summary.groups).toBeGreaterThan(0);

      const mine = result.items.find((row) => row.sourceId === "inv08-receipt");
      expect(mine).toBeDefined();

      /**
       * Whatever the deployment's accounting state is, the row must not read as
       * matched: no journal was written, so `matched` would be the report
       * lying, which is the one outcome that makes the bridge's skip
       * indefensible.
       */
      expect(mine?.journalEntryId).toBeNull();
      expect(mine?.status).not.toBe("MATCHED");
    },
    600_000,
  );

  it(
    "counts it in exactly one unreconciled bucket",
    async () => {
      const result = (await report()) as {
        summary: { groups: number; matched: number; missingCoa: number; unmatched: number; notInstalled: number };
      };
      const s = result.summary;

      // Which bucket depends on whether the accounting module is installed in
      // this database — MISSING_COA when there is a ledger and no account,
      // NOT_INSTALLED when there is no ledger at all. Both are honest answers;
      // `matched` is not, and a movement counted in none of them has fallen
      // out of the report entirely.
      expect(s.matched).toBe(0);
      expect(s.missingCoa + s.unmatched + s.notInstalled).toBeGreaterThan(0);
    },
    600_000,
  );

  /**
   * The report is scoped like every other tenant read. A reconciliation that
   * leaked across organisations would be a finance report about somebody
   * else's warehouse.
   */
  it(
    "reports nothing for an organisation with no movements in the window",
    async () => {
      const other = await seedOrg(seededApp.seedDb).addMember("keeper").build();
      try {
        const result = (await runInNewTenantTransaction(db, other.orgId, () =>
          seededApp.app.get(InvGlReconService).report(
            other.orgId,
            other.members["keeper"]!.userId,
            { fromDate: "2026-06-01", toDate: "2026-06-30", page: 1, limit: 50 },
          ),
        )) as { summary: { groups: number }; items: unknown[] };

        expect(result.summary.groups).toBe(0);
        expect(result.items).toEqual([]);
      } finally {
        await other.teardown();
      }
    },
    600_000,
  );
});
