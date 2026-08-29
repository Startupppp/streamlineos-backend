import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvCycleCountsService } from "src/modules/inventory/counts/inv-cycle-counts.service";
import { InvPhysicalAuditsService } from "src/modules/inventory/counts/inv-physical-audits.service";
import { INVENTORY_COMMAND_EVENTS } from "src/modules/inventory/stock-engine/command-events";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { outboxEventsFor } from "test/helpers/outbox-events";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * A2 — a correction points at what it corrects, and a posted movement stops
 * being editable.
 *
 * The second half is what makes the first half worth anything. A correction
 * link is a convention until the alternative — quietly editing the original —
 * is impossible; and it was not only possible, it was the normal path, because
 * costing inserted the ledger row and then UPDATEd its cost a moment later.
 *
 * That UPDATE is why the whole costing path had to be restructured to decide
 * the cost *before* the row is written. Which means every issue in every other
 * suite is now also a test of this: if costing still restated a posted
 * movement, the trigger would abort it and the receiving and order-to-ship
 * suites would go red.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  warehouseId: number;
}

/**
 * Drizzle wraps a driver error in a "Failed query:" Error and puts the real one
 * on `cause`, so asserting on the message alone silently matches nothing.
 */
function rootMessage(error: unknown): string {
  let current: unknown = error;
  const seen = new Set<unknown>();
  const parts: string[] = [];
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

describe("[seeded-e2e] ledger corrections and immutability", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let tag: string;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const engine = () => app.app.get(StockEngineService);

  /**
   * A bin of its own per case. Cost layers are keyed by (variant, location,
   * lot), so sharing one bin would let an earlier case's open layers answer a
   * later case's issue and the assertions would be about test order.
   */
  const newBin = async (label: string) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${scene.orgId}, ${scene.warehouseId}, ${label}, ${`${label}-${tag}`}, 'BIN', true)
        RETURNING id`),
    );
    return row!.id;
  };

  const post = (key: string, locationId: number, delta: string, unitCost?: string) =>
    asTenant(() =>
      engine().execute(scene.orgId, scene.userId, {
        idempotencyKey: key,
        sourceType: "ledger-fixture",
        sourceId: key,
        movements: [
          {
            transactionType: delta.startsWith("-") ? "SALE" : "PURCHASE",
            productVariantId: scene.variantId,
            locationId,
            quantityDelta: delta,
            ...(unitCost ? { unitCost } : {}),
          },
        ],
      }),
    );

  const ledgerRow = async (id: number) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        id: number;
        correction_of_transaction_id: number | null;
        quantity_change: string;
        unit_cost: string | null;
        total_cost: string | null;
      }>(sql`
        SELECT id, correction_of_transaction_id, quantity_change, unit_cost, total_cost
        FROM inv_stock_transactions WHERE org_id = ${scene.orgId} AND id = ${id}`),
    );
    return row!;
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["keeper"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Corrected goods', ${`LC-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`LC-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`LW${tag}`}, ${userId}) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        warehouseId: warehouse.id,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("links a compensating movement to the movement it compensates", async () => {
    const bin = await newBin("LNK");
    const receipt = await post(`lc-link-${tag}`, bin, "40.0000", "3.0000");
    const originalId = receipt.transactionIds[0]!;

    const reversal = await asTenant(() =>
      engine().reverse(scene.orgId, scene.userId, {
        idempotencyKey: `lc-link-rev-${tag}`,
        stockTransactionId: originalId,
        reason: "received against the wrong purchase order",
      }),
    );

    const correction = await ledgerRow(reversal.transactionIds[0]!);
    expect(correction.correction_of_transaction_id).toBe(originalId);
    // The pair sums to nothing, which is the whole point of a correction: the
    // original stays on the record and the position is put right.
    const original = await ledgerRow(originalId);
    expect(
      Number(original.quantity_change) + Number(correction.quantity_change),
    ).toBe(0);
    expect(original.correction_of_transaction_id).toBeNull();
  });

  it("refuses to reverse the same movement twice", async () => {
    const bin = await newBin("TWC");
    const receipt = await post(`lc-twice-${tag}`, bin, "25.0000", "2.0000");
    const originalId = receipt.transactionIds[0]!;

    await asTenant(() =>
      engine().reverse(scene.orgId, scene.userId, {
        idempotencyKey: `lc-twice-rev-a-${tag}`,
        stockTransactionId: originalId,
        reason: "first correction",
      }),
    );

    // A different idempotency key, so nothing about the retry machinery stops
    // this — the second unwind would be stock that never existed.
    await expect(
      asTenant(() =>
        engine().reverse(scene.orgId, scene.userId, {
          idempotencyKey: `lc-twice-rev-b-${tag}`,
          stockTransactionId: originalId,
          reason: "second correction",
        }),
      ),
    ).rejects.toThrow(/already been reversed/i);
  });

  it("writes an issue's derived cost on insert rather than restating it", async () => {
    const bin = await newBin("CST");
    await post(`lc-cost-in-${tag}`, bin, "10.0000", "7.5000");
    const issue = await post(`lc-cost-out-${tag}`, bin, "-4.0000");
    const row = await ledgerRow(issue.transactionIds[0]!);

    // The movement carried no unit cost; the cost came from the layers it
    // consumed. Before A2 that value arrived via an UPDATE, which the trigger
    // below now makes impossible — so a non-null cost here proves it was
    // resolved before the row was written.
    expect(Number(row.unit_cost)).toBeCloseTo(7.5, 4);
    expect(Number(row.total_cost)).toBeCloseTo(30, 4);
  });

  it("refuses to restate a posted movement, and still allows annotating it", async () => {
    const bin = await newBin("IMM");
    const receipt = await post(`lc-immutable-${tag}`, bin, "8.0000", "1.2500");
    const id = receipt.transactionIds[0]!;
    const db = () => app.app.get<Db>(DRIZZLE);

    const restatements: Array<[string, ReturnType<typeof sql>]> = [
      ["quantity_change", sql`quantity_change = quantity_change::numeric - 1, quantity_after = quantity_after::numeric - 1`],
      ["quantity_before", sql`quantity_before = quantity_before::numeric + 1, quantity_after = quantity_after::numeric + 1`],
      ["unit_cost", sql`unit_cost = 999`],
      ["posting_date", sql`posting_date = posting_date - 1`],
    ];

    for (const [field, assignment] of restatements) {
      // Caught outside the transaction: a failed statement poisons the whole
      // postgres.js transaction, so the rejection surfaces at the boundary and
      // a catch placed inside it never sees anything. Each attempt gets its own
      // transaction for the same reason.
      const failure = await asTenant(() =>
        db().execute(sql`
          UPDATE inv_stock_transactions SET ${assignment}
          WHERE org_id = ${scene.orgId} AND id = ${id}`),
      )
        .then(() => null)
        .catch((error: unknown) => rootMessage(error));
      expect(`${field}: ${failure ?? "the update was allowed"}`).toMatch(/append-only/i);
    }

    // Notes, reason and metadata describe the movement rather than being it.
    await asTenant(() =>
      db().execute(sql`
        UPDATE inv_stock_transactions SET notes = 'checked against the delivery note'
        WHERE org_id = ${scene.orgId} AND id = ${id}`),
    );

    const [row] = await asTenant(() =>
      db().execute<{ notes: string | null; quantity_change: string }>(sql`
        SELECT notes, quantity_change FROM inv_stock_transactions
        WHERE org_id = ${scene.orgId} AND id = ${id}`),
    );
    expect(row!.notes).toBe("checked against the delivery note");
    expect(Number(row!.quantity_change)).toBe(8);
  });

  /**
   * A5, item 3 — a count posts a correction, and says so.
   *
   * A count is the one correction that comes from outside the system: somebody
   * walked the aisle and the books were wrong. Posting it wrote movements and
   * flipped a status, and told nobody — so an auditor, a finance close or a
   * shrinkage report could not be driven off the event stream and had to poll
   * `inv_cycle_counts` for rows that had changed.
   *
   * Cycle counts and wall-to-wall audits share one event type, discriminated by
   * `countType`: to anyone downstream they are the same fact — the books were
   * corrected against a physical count — and splitting them would make every
   * consumer subscribe twice to hear it.
   *
   * Each count gets its own warehouse. `createCycleCount` snapshots every stock
   * level in the warehouse it names, so sharing one would make the line counts
   * depend on which other cases had run first.
   */
  describe("the events a count owes", () => {
    /**
     * Narrowed by aggregate type as well as id. A cycle count and a physical
     * audit share one event type and live in different tables, so their ids
     * come from different sequences and will eventually coincide — without this
     * the two probes below would occasionally count each other's events.
     */
    const eventsFor = async (aggregateType: string, aggregateId: string) => {
      const rows = await asTenant(() =>
        outboxEventsFor(
          app.app.get<Db>(DRIZZLE),
          scene.orgId,
          INVENTORY_COMMAND_EVENTS.COUNT_POSTED,
          aggregateId,
        ),
      );
      return rows.filter((row) => row.aggregateType === aggregateType);
    };

    /** A warehouse of its own, one bin, stocked through the engine. */
    const countableWarehouse = async (label: string, qty: string) => {
      const suffix = randomUUID().slice(0, 6);
      const db = app.app.get<Db>(DRIZZLE);
      const made = await asTenant(async () => {
        const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
          (await db.execute<T>(q))[0]!;
        const warehouse = await one<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${scene.orgId}, ${label}, ${`${label}${suffix}`.slice(0, 20)}, ${scene.userId})
          RETURNING id`);
        const location = await one<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
          VALUES (${scene.orgId}, ${warehouse.id}, 'Bin', ${`${label}B${suffix}`.slice(0, 20)}, 'BIN', true)
          RETURNING id`);
        return { warehouseId: Number(warehouse.id), locationId: Number(location.id) };
      });

      await asTenant(() =>
        engine().execute(scene.orgId, scene.userId, {
          idempotencyKey: `count-seed-${suffix}`,
          sourceType: "ledger-fixture",
          sourceId: suffix,
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: scene.variantId,
              locationId: made.locationId,
              quantityDelta: qty,
              unitCost: "1.0000",
            },
          ],
        }),
      );
      return made;
    };

    it("announces a posted cycle count once, with the variance it found", async () => {
      const where = await countableWarehouse("CYC", "30.0000");
      const counts = app.app.get(InvCycleCountsService);

      const created = await asTenant(() =>
        counts.createCycleCount(scene.orgId, scene.userId, {
          warehouseId: where.warehouseId,
        } as never),
      );
      const countId = (created as { id: number }).id;

      await asTenant(() => counts.startCycleCount(scene.orgId, countId));
      const lines = (created as { lines: Array<{ id: number }> }).lines;
      expect(lines).toHaveLength(1);
      // Counted short by two: a count that finds nothing is the normal outcome
      // and would not prove the variance is being reported.
      await asTenant(() =>
        counts.updateLines(scene.orgId, countId, {
          lines: [{ lineId: lines[0]!.id, countedQty: 28 }],
        } as never),
      );
      await asTenant(() => counts.reviewCycleCount(scene.orgId, countId));

      const key = `cyc-post-${randomUUID().slice(0, 8)}`;
      await asTenant(() =>
        counts.postCycleCount(scene.orgId, scene.userId, countId, key),
      );

      const events = await eventsFor("inv_cycle_count", String(countId));
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.countType).toBe("CYCLE");
      expect(events[0]!.payload.warehouseId).toBe(where.warehouseId);
      expect(events[0]!.payload.lineCount).toBe(1);
      expect(events[0]!.payload.varianceLineCount).toBe(1);
      expect(events[0]!.payload.idempotencyKey).toBe(key);

      // A posted count cannot be posted again — the status guard refuses before
      // the transaction opens, so nothing announces a second correction.
      await expect(
        asTenant(() =>
          counts.postCycleCount(
            scene.orgId,
            scene.userId,
            countId,
            `cyc-post-again-${randomUUID().slice(0, 8)}`,
          ),
        ),
      ).rejects.toThrow();
      expect(await eventsFor("inv_cycle_count", String(countId))).toHaveLength(1);
    });

    it("announces a posted physical audit under the same event type", async () => {
      const where = await countableWarehouse("AUD", "40.0000");
      const audits = app.app.get(InvPhysicalAuditsService);

      const created = await asTenant(() =>
        audits.createAudit(scene.orgId, scene.userId, {
          warehouseId: where.warehouseId,
        } as never),
      );
      const auditId = (created as { id: number }).id;
      const lines = (created as { lines: Array<{ id: number }> }).lines;
      expect(lines).toHaveLength(1);

      await asTenant(() => audits.startAudit(scene.orgId, auditId));
      await asTenant(() =>
        audits.updateLines(scene.orgId, auditId, {
          lines: [{ lineId: lines[0]!.id, countedQty: 40 }],
        } as never),
      );
      await asTenant(() => audits.reviewAudit(scene.orgId, auditId));

      const key = `aud-post-${randomUUID().slice(0, 8)}`;
      await asTenant(() => audits.postAudit(scene.orgId, scene.userId, auditId, key));

      const events = await eventsFor("inv_physical_audit", String(auditId));
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.countType).toBe("PHYSICAL");
      expect(events[0]!.payload.warehouseId).toBe(where.warehouseId);
      // A count that agrees with the books is still a fact worth publishing —
      // "we looked, and nothing was missing" is what an auditor is waiting for.
      expect(events[0]!.payload.varianceLineCount).toBe(0);
    });
  });
});
