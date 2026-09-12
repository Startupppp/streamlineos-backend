import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { StockEngineBatchService } from "src/modules/inventory/stock-engine/stock-engine-batch.service";
import type { StockEngineCommand, StockEngineResult } from "src/modules/inventory/stock-engine/stock-engine.types";
import { inventoryCounters } from "src/modules/inventory/observability/inventory-counters";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";
import { buildInventoryFixture, type InventoryFixture } from "test/helpers/inventory-fixture";

/**
 * INV-02 — one command list, two doors, and the same warehouse behind both.
 *
 * `StockEngineService.executeInTx` and `StockEngineBatchService.executeManyInTx`
 * are two entry points to one kernel. That is the design: the batch path claims
 * every idempotency key, takes every row lock in natural-key order, then calls
 * `MovementApplyService.apply` exactly as the single path does. Nothing here
 * checks that they call the same function — INV-01's gate does that, by reading
 * the source.
 *
 * What is unprovable by reading is whether they *arrive at the same place*. The
 * batch path does real work of its own before it delegates — hashing, claiming,
 * grouping, ordering locks — and every one of those is a chance to lose a
 * movement, merge two grains that should stay apart, or apply a command twice.
 * A bug in any of them leaves both paths individually green, because each has
 * its own tests and neither has ever been asked to agree with the other.
 *
 * So: two organisations seeded from the same fixture builder, the same commands
 * posted one at a time through one and all at once through the other, and then
 * the two warehouses compared. Ids differ between tenants and are worthless as
 * a comparison, so everything is compared by natural key with the fixture's own
 * names substituted for its ids.
 *
 *   pnpm test:e2e:seeded --testPathPattern=batch-single-equivalence
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
];

/** Compared shapes, with every tenant-specific id replaced by a fixture name. */
interface NormalisedLevel {
  variant: string;
  location: string;
  lot: string | null;
  ownership: string;
  onHand: string;
  committed: string;
  blockedQty: string;
  qualityHoldQty: string;
  outgoingQty: string;
}

interface NormalisedTransaction {
  variant: string;
  location: string;
  lot: string | null;
  ownership: string;
  transactionType: string;
  quantityDelta: string;
  quantityBucket: string;
}

interface Side {
  orgId: string;
  userId: string;
  fixture: InventoryFixture;
}

describe("[seeded-e2e] INV-02 — the batch door and the single door reach the same warehouse", () => {
  let seededApp: SeededE2eApp;
  let db: Db;
  let single: Side;
  let batch: Side;
  /** Counter totals immediately before the replay, so the replay can be measured as a delta. */
  let countersBeforeReplay: { single: Record<string, number>; batch: Record<string, number> } | null = null;
  const teardowns: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
    db = seededApp.app.get<Db>(DRIZZLE);

    const build = async (tag: string): Promise<Side> => {
      const seeded = await seedOrg(seededApp.seedDb)
        .addMember("keeper", { permissionKeys: PERMISSIONS })
        .build();
      teardowns.push(() => seeded.teardown());
      const userId = seeded.members["keeper"]!.userId;
      const fixture = await buildInventoryFixture(seededApp.app, seeded.orgId, userId, tag);
      return { orgId: seeded.orgId, userId, fixture };
    };

    single = await build("eq-single");
    batch = await build("eq-batch");
  }, 600_000);

  afterAll(async () => {
    for (const teardown of teardowns.reverse()) await teardown().catch(() => undefined);
    if (seededApp) await seededApp.close();
  }, 120_000);

  /**
   * The same work, expressed against whichever tenant is being driven.
   *
   * Deliberately more than one command and more than one movement per command:
   * a batch that flattened its commands, or that applied only the first
   * movement of each, would still pass a single-command comparison. Two of them
   * touch the same grain, because ordering within a batch is where a lock
   * sequence can differ from the sequential one.
   */
  const commandsFor = (side: Side): StockEngineCommand[] => {
    const f = side.fixture;
    const key = (n: string) => `inv02-${side.fixture.orgId}-${n}`;
    return [
      {
        idempotencyKey: key("receipt"),
        sourceType: "TEST",
        sourceId: "inv02-1",
        reason: "equivalence receipt",
        postingDate: "2026-06-02",
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: f.variants.widget.variantId,
            locationId: f.locations.mainBin,
            quantityDelta: "25.0000",
            unitCost: "3.5000",
          },
          {
            transactionType: "PURCHASE",
            productVariantId: f.variants.gadget.variantId,
            locationId: f.locations.mainBin,
            lotId: f.lots.lotA,
            quantityDelta: "15.0000",
            unitCost: "2.0000",
          },
        ],
      },
      {
        idempotencyKey: key("issue"),
        sourceType: "TEST",
        sourceId: "inv02-2",
        reason: "equivalence issue",
        postingDate: "2026-06-02",
        movements: [
          {
            // The same grain the first command received into: the interesting
            // case, because a batch orders its locks and a sequence does not.
            transactionType: "ADJUSTMENT_OUT",
            productVariantId: f.variants.widget.variantId,
            locationId: f.locations.mainBin,
            quantityDelta: "-10.0000",
          },
        ],
      },
      {
        idempotencyKey: key("transfer"),
        sourceType: "TEST",
        sourceId: "inv02-3",
        reason: "equivalence move",
        postingDate: "2026-06-02",
        movements: [
          {
            transactionType: "TRANSFER_OUT",
            productVariantId: f.variants.sprocket.variantId,
            locationId: f.locations.mainBin,
            quantityDelta: "-5.0000",
          },
          {
            transactionType: "TRANSFER_IN",
            productVariantId: f.variants.sprocket.variantId,
            locationId: f.locations.overflowBin,
            quantityDelta: "5.0000",
          },
        ],
      },
    ];
  };

  /** Fixture ids → stable names, so two tenants can be compared at all. */
  const namesFor = (side: Side) => {
    const f = side.fixture;
    const variants = new Map<number, string>([
      [f.variants.widget.variantId, "widget"],
      [f.variants.gadget.variantId, "gadget"],
      [f.variants.sprocket.variantId, "sprocket"],
    ]);
    const locations = new Map<number, string>([
      [f.locations.mainBin, "mainBin"],
      [f.locations.mainQc, "mainQc"],
      [f.locations.overflowBin, "overflowBin"],
    ]);
    const lots = new Map<number, string>([
      [f.lots.lotA, "lotA"],
      [f.lots.lotB, "lotB"],
    ]);
    return { variants, locations, lots };
  };

  async function levelsOf(side: Side): Promise<NormalisedLevel[]> {
    const names = namesFor(side);
    // In a tenant transaction: these suites run as the application role, and a
    // context-less read of a table behind `tenant_isolation` raises rather than
    // returning nothing.
    const rows = await runInNewTenantTransaction(db, side.orgId, (tx) =>
      tx.execute<{
        product_variant_id: number; location_id: number; lot_id: number | null;
        ownership: string; on_hand: string; committed: string; blocked_qty: string;
        quality_hold_qty: string; outgoing_qty: string;
      }>(sql`
        SELECT product_variant_id, location_id, lot_id, ownership,
               on_hand, committed, blocked_qty, quality_hold_qty, outgoing_qty
          FROM inv_stock_levels WHERE org_id = ${side.orgId}
      `),
    );

    return rows
      .map((r) => ({
        variant: names.variants.get(r.product_variant_id) ?? `?${r.product_variant_id}`,
        location: names.locations.get(r.location_id) ?? `?${r.location_id}`,
        lot: r.lot_id === null ? null : (names.lots.get(r.lot_id) ?? `?${r.lot_id}`),
        ownership: r.ownership,
        onHand: r.on_hand,
        committed: r.committed,
        blockedQty: r.blocked_qty,
        qualityHoldQty: r.quality_hold_qty,
        outgoingQty: r.outgoing_qty,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  async function ledgerOf(side: Side): Promise<NormalisedTransaction[]> {
    const names = namesFor(side);
    const rows = await runInNewTenantTransaction(db, side.orgId, (tx) =>
      tx.execute<{
        product_variant_id: number; location_id: number; lot_id: number | null;
        ownership: string; transaction_type: string; quantity_change: string;
        quantity_bucket: string;
      }>(sql`
        SELECT product_variant_id, location_id, lot_id, ownership,
               transaction_type, quantity_change, quantity_bucket
          FROM inv_stock_transactions
         WHERE org_id = ${side.orgId} AND reference_type = 'TEST'
      `),
    );

    return rows
      .map((r) => ({
        variant: names.variants.get(r.product_variant_id) ?? `?${r.product_variant_id}`,
        location: names.locations.get(r.location_id) ?? `?${r.location_id}`,
        lot: r.lot_id === null ? null : (names.lots.get(r.lot_id) ?? `?${r.lot_id}`),
        ownership: r.ownership,
        transactionType: r.transaction_type,
        quantityDelta: r.quantity_change,
        quantityBucket: r.quantity_bucket,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  /**
   * INV-06 — the cost layers each door left behind.
   *
   * Costing is where the batch path does the most work of its own:
   * `costFromMovementIndex` resolves against costs derived earlier in the SAME
   * command, so a batch that grouped or reordered movements differently would
   * produce a valid-looking ledger with the wrong money on it. Levels and
   * transaction rows would still match; only the layers would disagree.
   *
   * Compared by natural key with the fixture's names, like everything else —
   * `stock_transaction_id` differs between tenants and says nothing.
   */
  async function layersOf(side: Side): Promise<
    Array<{ variant: string; quantity: string; unitCost: string; totalValue: string;
            remainingQuantity: string; costingMethod: string }>
  > {
    const names = namesFor(side);
    const rows = await runInNewTenantTransaction(db, side.orgId, (tx) =>
      tx.execute<{
        product_variant_id: number; quantity: string; unit_cost: string;
        total_value: string; remaining_quantity: string; costing_method: string;
      }>(sql`
        SELECT product_variant_id, quantity, unit_cost, total_value,
               remaining_quantity, costing_method
          FROM inv_valuation_layers
         WHERE org_id = ${side.orgId} AND source_type = 'TEST'
      `),
    );

    return rows
      .map((r) => ({
        variant: names.variants.get(r.product_variant_id) ?? `?${r.product_variant_id}`,
        quantity: r.quantity,
        unitCost: r.unit_cost,
        totalValue: r.total_value,
        remainingQuantity: r.remaining_quantity,
        costingMethod: r.costing_method,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  async function outboxOf(side: Side): Promise<Record<string, number>> {
    const rows = await runInNewTenantTransaction(db, side.orgId, (tx) =>
      tx.execute<{ event_type: string; n: number }>(sql`
        SELECT event_type, count(*)::int AS n
          FROM outbox_events WHERE organization_id = ${side.orgId}
         GROUP BY event_type
      `),
    );
    return Object.fromEntries(rows.map((r) => [r.event_type, r.n]));
  }

  it(
    "posts the same commands through both doors",
    async () => {
      const engine = seededApp.app.get(StockEngineService);
      const batchEngine = seededApp.app.get(StockEngineBatchService);

      const singleResults = await runInNewTenantTransaction(db, single.orgId, async (tx) => {
        const out: StockEngineResult[] = [];
        for (const cmd of commandsFor(single))
          out.push(await engine.executeInTx(tx, single.orgId, single.userId, cmd));
        return out;
      });

      const batchResults = await runInNewTenantTransaction(db, batch.orgId, (tx) =>
        batchEngine.executeManyInTx(tx, batch.orgId, batch.userId, commandsFor(batch)),
      );

      /*
       * This case asserted nothing at all until 2026-09-12 — it posted and
       * returned, and every comparison below it reads the database rather than
       * what the engines returned. So the one claim nobody was checking is the
       * one the batch door is most able to break: that `executeManyInTx` answers
       * once per command. Returning fewer results while writing every row leaves
       * the whole ledger/levels/outbox comparison below green.
       */
      // Three commands carrying five movements between them — the floor is on
      // commands, because that is what each door answers one result for.
      expect(singleResults).toHaveLength(commandsFor(single).length);
      expect(singleResults.length).toBeGreaterThanOrEqual(3);
      expect(batchResults).toHaveLength(singleResults.length);
    },
    600_000,
  );

  /**
   * The floor. Both sides being empty, or the fixture failing to seed, would
   * make every comparison below trivially true — which is the failure mode a
   * differential test is most prone to.
   */
  it("moved a measurable amount of stock on both sides", async () => {
    const [a, b] = await Promise.all([ledgerOf(single), ledgerOf(batch)]);

    expect(a.length).toBeGreaterThanOrEqual(5);
    expect(b.length).toBe(a.length);
  });

  it("leaves identical stock levels", async () => {
    const [a, b] = await Promise.all([levelsOf(single), levelsOf(batch)]);
    expect(b).toEqual(a);
  });

  it("writes an identical ledger", async () => {
    const [a, b] = await Promise.all([ledgerOf(single), ledgerOf(batch)]);
    expect(b).toEqual(a);
  });

  it("builds identical cost layers", async () => {
    const [a, b] = await Promise.all([layersOf(single), layersOf(batch)]);

    // The floor again: two empty layer sets are equal and prove nothing, and
    // only the receipts in this command list carry a unit cost.
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(b).toEqual(a);
  });

  it("emits the same events, the same number of times", async () => {
    const [a, b] = await Promise.all([outboxOf(single), outboxOf(batch)]);
    expect(b).toEqual(a);
  });

  /**
   * INV-36 — the counters an operator reads, compared the same way.
   *
   * `inventoryCounters` had exactly one test and it asserted the *source text*:
   * it read `movement-apply.service.ts` off disk and checked the file contained
   * the literal `inventoryCounters.increment(orgId, "stock.command.success")`.
   * That passes against a call sitting behind an `if (false)`, and it passes
   * against a batch path that increments once per batch instead of once per
   * command. Nothing had ever executed the engine and looked at a number.
   *
   * The counters are per-organisation and the two sides are two organisations
   * running the identical command list, so parity is the natural assertion and
   * it needs no fixture of its own: whatever the single door counted, the batch
   * door must have counted too.
   */
  it("counts the same commands on both doors", () => {
    const a = inventoryCounters.snapshotFor(single.orgId);
    const b = inventoryCounters.snapshotFor(batch.orgId);

    // The floor. Two all-zero snapshots are equal and would prove nothing —
    // which is exactly what this file would have reported before the counter
    // was wired up at all.
    expect(a["stock.command.success"]).toBeGreaterThanOrEqual(5);
    // One success per applied command, not per batch: the batch orchestrator
    // calls `apply` once per command and the counter lives inside it.
    expect(b["stock.command.success"]).toBe(a["stock.command.success"]);
    expect(b).toEqual(a);
  });

  /**
   * Replay is where the two paths are most likely to disagree, because the
   * batch claims every key up front and the sequence claims them one at a time.
   * A batch that re-applied on replay would double the warehouse.
   */
  it("replays identically on both doors, applying nothing twice", async () => {
    const before = {
      levels: await Promise.all([levelsOf(single), levelsOf(batch)]),
      ledger: await Promise.all([ledgerOf(single), ledgerOf(batch)]),
    };
    countersBeforeReplay = {
      single: inventoryCounters.snapshotFor(single.orgId),
      batch: inventoryCounters.snapshotFor(batch.orgId),
    };

    const engine = seededApp.app.get(StockEngineService);
    const batchEngine = seededApp.app.get(StockEngineBatchService);

    await runInNewTenantTransaction(db, single.orgId, async (tx) => {
      for (const cmd of commandsFor(single))
        await engine.executeInTx(tx, single.orgId, single.userId, cmd);
    });
    await runInNewTenantTransaction(db, batch.orgId, async (tx) => {
      await batchEngine.executeManyInTx(tx, batch.orgId, batch.userId, commandsFor(batch));
    });

    expect(await levelsOf(single)).toEqual(before.levels[0]);
    expect(await levelsOf(batch)).toEqual(before.levels[1]);
    expect(await ledgerOf(single)).toEqual(before.ledger[0]);
    expect(await ledgerOf(batch)).toEqual(before.ledger[1]);
  }, 600_000);

  /**
   * INV-36, the half that matters more than parity: a replay must be counted as
   * a replay. A path that counted the second run a success would report a
   * warehouse doing twice the work it did, and the ratio the counters exist to
   * feed — conflicts over attempts — would be wrong in the reassuring direction.
   */
  it("counts the replay as a replay on both doors, not as more successes", () => {
    // Measured as a DELTA across the replay, which is the only form of this
    // assertion that can be true.
    //
    // It used to compare running totals: `replayed >= 5`, then
    // `replayed === success`. Neither could ever hold. `success` counts every
    // command that has ever applied against the tenant, and `buildInventoryFixture`
    // posts eight of its own before this file posts anything, so `success` is 11
    // where `replayed` can only reach 3 — the number of commands `commandsFor`
    // actually re-runs. The floor of 5 was copied from the success assertion above
    // without noticing that the two counters are counting different populations,
    // and the file has been red for as long as anything has run it.
    //
    // The delta says what the docstring above always meant: re-running the same
    // three commands adds three replays and NOT ONE success. A door that
    // re-applied on replay would show a success delta here and double the
    // warehouse.
    expect(countersBeforeReplay).not.toBeNull();
    const beforeSingle = countersBeforeReplay!.single;
    const beforeBatch = countersBeforeReplay!.batch;
    const a = inventoryCounters.snapshotFor(single.orgId);
    const b = inventoryCounters.snapshotFor(batch.orgId);

    const replayedCommands = commandsFor(single).length;
    expect(replayedCommands).toBeGreaterThanOrEqual(3);

    expect(a["stock.command.replayed"] - beforeSingle["stock.command.replayed"])
      .toBe(replayedCommands);
    expect(b["stock.command.replayed"] - beforeBatch["stock.command.replayed"])
      .toBe(replayedCommands);

    expect(a["stock.command.success"] - beforeSingle["stock.command.success"]).toBe(0);
    expect(b["stock.command.success"] - beforeBatch["stock.command.success"]).toBe(0);

    // And the two doors remain indistinguishable by every counter, which is what
    // the rest of this file is about.
    expect(b).toEqual(a);
  });
});
