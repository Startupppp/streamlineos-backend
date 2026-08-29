import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db, TenantTx } from "src/db/drizzle.types";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { GrnPostingService } from "src/modules/inventory/purchase-orders/grn-post.service";
import { InspectionPlansService } from "src/modules/inventory/quality/inspection-plans.service";
import { InspectionsService } from "src/modules/inventory/quality/quality-inspections.service";
import { ReceiptInspectionService } from "src/modules/inventory/quality/receipt-inspection.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * D3 — a receipt that has to be inspected does not raise ATP.
 *
 * Everything below is asserted through the availability formula the rest of the
 * module computes with, never by reading `quality_hold_qty` and calling it a
 * result:
 *
 *   available = on_hand - committed - blocked_qty - quality_hold_qty - outgoing_qty
 *
 * Reading the hold column would pass against a change that raised the bucket and
 * broke the subtraction, which is the one thing this unit exists to make true.
 * `on_hand` is asserted beside it because the goods have physically arrived: a
 * hold is a legal state, and a stock count taken the moment after the delivery
 * must still find every unit of it.
 *
 * **The composition under test.** The receipt path is another lane's file, so
 * this spec composes what the wiring will do rather than waiting for it:
 * `GrnPostingService.postInTx` and `ReceiptInspectionService.raiseForReceiptInTx`
 * on **one** transaction. That is not a convenience — a hold raised after the
 * receipt's commit is a window in which uninspected goods are for sale, so the
 * single transaction is the behaviour, and a spec that posted and then raised
 * separately would prove a weaker thing.
 *
 *   pnpm test:e2e:seeded --testPathPattern=inspection-plan-receipt-hold
 */

const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:receive",
  "inventory:quality:read",
  "inventory:quality:inspect",
  "inventory:quality:release",
  "inventory:quality:plans:manage",
] as const;

interface Level {
  onHand: string;
  qualityHold: string;
  blocked: string;
  available: string;
}

interface Scene {
  orgId: string;
  userId: string;
  categoryId: number;
  /** Covered by a plan scoped to the category. */
  plannedVariantId: number;
  /** Same category is deliberately NOT used here — this one no plan reaches. */
  freeVariantId: number;
  warehouseId: number;
  locationId: number;
  vendorId: number;
}

describe("[seeded-e2e] inspection plans hold a receipt out of ATP until it is dispositioned", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** Availability at a variant, summed the way every allocator reads it. */
  const levelFor = (variantId: number): Promise<Level> =>
    asTenant(async () => {
      const rows = await app.app.get<Db>(DRIZZLE).execute<Level>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::numeric(18, 4)::text                   AS "onHand",
               COALESCE(SUM(COALESCE(quality_hold_qty, 0)), 0)::numeric(18, 4)::text AS "qualityHold",
               COALESCE(SUM(COALESCE(blocked_qty, 0)), 0)::numeric(18, 4)::text      AS blocked,
               -- Cast to the column's own scale: SUM over zero rows falls back to
               -- an integer literal, which renders "0" and compares unequal to
               -- the "0.0000" every populated row produces.
               COALESCE(SUM(on_hand - committed
                           - COALESCE(blocked_qty, 0)
                           - COALESCE(quality_hold_qty, 0)
                           - COALESCE(outgoing_qty, 0)), 0)::numeric(18, 4)::text AS available
        FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}`);
      return rows[0]!;
    });

  /**
   * A sent order, counted at the dock, posted, and the inspection it owes raised
   * — all inside one transaction, which is the arrangement the receipt path will
   * carry once it calls the quality service instead of inserting into its table.
   */
  async function receiveAndRaise(variantId: number, quantity: number) {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-01",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          { productVariantId: variantId, quantity, unitCost: "10.0000", taxRate: "0", lineOrder: 0 },
        ],
      }),
    );
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, po.id, scene.userId));
    const [poLine] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${po.id}`),
    );

    const draft = await asTenant(() =>
      app.app.get(GrnService).createDraft(scene.orgId, scene.userId, `draft-${randomUUID()}`, {
        poId: po.id,
        receivedDate: "2026-08-02",
        locationId: scene.locationId,
        lines: [
          {
            poLineId: poLine!.id,
            quantityReceived: `${quantity}.0000`,
            qualityStatus: "ACCEPTED" as const,
          },
        ],
      }),
    );
    const grnId = (draft as { id: number }).id;
    const grnNumber = (draft as { grnNumber: string }).grnNumber;

    // `postInTx` raises the inspection itself now — the receipt path calls
    // `raiseForReceiptInTx` as its last step. This spec used to call it here as
    // well, standing in for wiring that did not exist yet; once the wiring
    // landed that became a *second* hold over the same quantity, and since a
    // hold is a subset of on-hand, 200 held against 100 received trips
    // HOLD_EXCEEDS_ON_HAND and rolls the whole receipt back.
    const key = `post-${randomUUID()}`;
    await asTenant(async (tx) => {
      await app.app.get(GrnPostingService).postInTx(tx, scene.orgId, grnId, scene.userId, key);
    });
    const raised = await openInspectionFor(grnId);
    await app.app.get(GrnPostingService).invalidateAfterPost(scene.orgId, po.id);
    await app.app.get(ReceiptInspectionService).invalidateAfterRaise(scene.orgId);
    return { grnId, raised };
  }

  /** What the receipt path raised, read back rather than returned by the call. */
  async function openInspectionFor(grnId: number) {
    const [row] = await asTenant((tx) =>
      tx.execute<{ id: number; inspection_number: string }>(sql`
        SELECT id, inspection_number FROM inv_quality_inspections
         WHERE org_id = ${scene.orgId} AND source_type = 'inv_grn'
           AND source_id = ${String(grnId)}
         ORDER BY id DESC LIMIT 1`),
    );
    return row ? { inspectionId: Number(row.id), inspectionNumber: String(row.inspection_number) } : null;
  }

  const inspections = () => app.app.get(InspectionsService);

  /** PENDING → IN_PROGRESS, which is where a verdict may be recorded. */
  const startInspection = (inspectionId: number) =>
    asTenant(() => inspections().start(scene.orgId, scene.userId, inspectionId));

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("qc", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["qc"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const category = await one<{ id: number }>(sql`
        INSERT INTO inv_categories (org_id, name)
        VALUES (${seeded.orgId}, ${`Regulated ${tag}`}) RETURNING id`);
      const plannedProduct = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, category_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, ${category.id}, 'Regulated goods', ${`QP-${tag}`}, 'NONE', ${userId})
        RETURNING id`);
      const plannedVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${plannedProduct.id}, 'Default', ${`QP-${tag}-V`}) RETURNING id`);
      const freeProduct = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Ordinary goods', ${`QF-${tag}`}, 'NONE', ${userId})
        RETURNING id`);
      const freeVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${freeProduct.id}, 'Default', ${`QF-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Dock', ${`DK${tag}`}, 'RECEIVING') RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'QC vendor', ${`VN${tag}`}, ${userId}) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        categoryId: category.id,
        plannedVariantId: plannedVariant.id,
        freeVariantId: freeVariant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        vendorId: vendor.id,
      };
    });

    // The plan under test: everything in this category is inspected on receipt,
    // opening ten percent of what arrives.
    await runInNewTenantTransaction(db, scene.orgId, () =>
      app.app.get(InspectionPlansService).create(scene.orgId, scene.userId, {
        code: `CAT-${tag}`,
        name: "Regulated category intake",
        categoryId: scene.categoryId,
        appliesOnReceipt: true,
        appliesOnReturn: false,
        samplingMethod: "PERCENTAGE",
        sampleValue: "10",
      } as never),
    );
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("a SKU no plan covers", () => {
    it("posts straight into available stock", async () => {
      // The control. Without it every assertion below would also pass against a
      // change that simply stopped receipts raising ATP at all.
      const { raised } = await receiveAndRaise(scene.freeVariantId, 30);
      expect(raised).toBeNull();

      const after = await levelFor(scene.freeVariantId);
      expect(after.onHand).toBe("30.0000");
      expect(after.qualityHold).toBe("0.0000");
      expect(after.available).toBe("30.0000");
    });
  });

  describe("a SKU the plan covers", () => {
    let inspectionId: number;

    it("leaves ATP exactly where it was, with the goods on the shelf", async () => {
      const before = await levelFor(scene.plannedVariantId);
      expect(before.available).toBe("0.0000");

      const { raised } = await receiveAndRaise(scene.plannedVariantId, 100);
      expect(raised).not.toBeNull();
      inspectionId = raised!.inspectionId;

      const after = await levelFor(scene.plannedVariantId);
      // The goods arrived — a stock count finds all hundred, and valuation owns
      // them. What has not happened is that they became sellable.
      expect(after.onHand).toBe("100.0000");
      expect(after.available).toBe(before.available);
    });

    it("records the sample the plan asked for, and holds the whole delivery", async () => {
      // Ten percent of a hundred is ten units to open; the batch those ten are
      // drawn from is what is quarantined, because a failed sample condemns it.
      const [line] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{
          quantity: string;
          held_quantity: string;
          sample_quantity: string;
          location_id: number;
          plan_version_id: number | null;
        }>(sql`
          SELECT quantity, held_quantity, sample_quantity, location_id, plan_version_id
          FROM inv_quality_inspection_lines
          WHERE org_id = ${scene.orgId} AND inspection_id = ${inspectionId}`),
      );
      expect(line!.quantity).toBe("100.0000");
      expect(line!.held_quantity).toBe("100.0000");
      expect(line!.sample_quantity).toBe("10.0000");
      expect(line!.location_id).toBe(scene.locationId);
      // The version, not the plan: the rule this result was judged against has
      // to stay readable after somebody tightens the sampling.
      expect(line!.plan_version_id).not.toBeNull();
    });

    it("gives the quantity back to ATP when the inspection passes", async () => {
      await startInspection(inspectionId);
      await asTenant(() =>
        inspections().pass(scene.orgId, scene.userId, inspectionId, `pass-${randomUUID()}`),
      );

      const after = await levelFor(scene.plannedVariantId);
      expect(after.onHand).toBe("100.0000");
      expect(after.qualityHold).toBe("0.0000");
      expect(after.available).toBe("100.0000");
    });

    it("replays a retried pass without releasing twice", async () => {
      // The release is exact — `held_quantity`, now zero — so a second attempt
      // under a fresh key moves nothing, and under the same key replays. Either
      // way the engine must not see a negative hold.
      const key = `pass-again-${randomUUID()}`;
      await asTenant(() =>
        inspections().pass(scene.orgId, scene.userId, inspectionId, key),
      ).catch(() => undefined);
      const after = await levelFor(scene.plannedVariantId);
      expect(after.qualityHold).toBe("0.0000");
      expect(after.available).toBe("100.0000");
    });
  });

  describe("a failed inspection", () => {
    it("can quarantine the goods, and they stay out of ATP", async () => {
      const baseline = await levelFor(scene.plannedVariantId);
      const { raised } = await receiveAndRaise(scene.plannedVariantId, 40);
      const inspection = raised!.inspectionId;
      const lineId = await firstLineId(inspection);

      await startInspection(inspection);
      await asTenant(() =>
        inspections().fail(scene.orgId, scene.userId, inspection, {
          lines: [{ lineId, disposition: "QUARANTINE" }],
        } as never),
      );

      // Still held while the disposition is outstanding: failing is not deciding.
      const failed = await levelFor(scene.plannedVariantId);
      expect(failed.available).toBe(baseline.available);

      await asTenant(() =>
        inspections().dispose(
          scene.orgId,
          scene.userId,
          inspection,
          { lines: [{ lineId, disposition: "QUARANTINE" }] } as never,
          `dispose-${randomUUID()}`,
        ),
      );

      const after = await levelFor(scene.plannedVariantId);
      // The hold gave way to a block, in one command and in that order: both are
      // subsets of on_hand, so blocking before releasing would have been refused
      // outright with HOLD_EXCEEDS_ON_HAND.
      expect(after.onHand).toBe("140.0000");
      expect(after.qualityHold).toBe("0.0000");
      expect(after.blocked).toBe("40.0000");
      expect(after.available).toBe(baseline.available);
    });

    it("can scrap the goods, taking them off the shelf as well as out of ATP", async () => {
      const baseline = await levelFor(scene.plannedVariantId);
      const { raised } = await receiveAndRaise(scene.plannedVariantId, 25);
      const inspection = raised!.inspectionId;
      const lineId = await firstLineId(inspection);

      await startInspection(inspection);
      await asTenant(() =>
        inspections().fail(scene.orgId, scene.userId, inspection, {
          lines: [{ lineId, disposition: "SCRAP" }],
        } as never),
      );
      await asTenant(() =>
        inspections().dispose(
          scene.orgId,
          scene.userId,
          inspection,
          { lines: [{ lineId, disposition: "SCRAP" }] } as never,
          `scrap-${randomUUID()}`,
        ),
      );

      const after = await levelFor(scene.plannedVariantId);
      // Scrapping a fully-held grain is the case that used to be impossible: the
      // issue drives on_hand down past a hold that is still standing, which the
      // coherence guard refuses. The release leg comes first, in the same command.
      expect(after.onHand).toBe(baseline.onHand);
      expect(after.qualityHold).toBe("0.0000");
      expect(after.available).toBe(baseline.available);
    });
  });

  describe("cancelling an inspection", () => {
    it("hands back what it was holding rather than stranding it", async () => {
      const baseline = await levelFor(scene.plannedVariantId);
      const { raised } = await receiveAndRaise(scene.plannedVariantId, 12);
      expect((await levelFor(scene.plannedVariantId)).available).toBe(baseline.available);

      await asTenant(() =>
        inspections().cancel(
          scene.orgId,
          scene.userId,
          raised!.inspectionId,
          `cancel-${randomUUID()}`,
        ),
      );

      const after = await levelFor(scene.plannedVariantId);
      // Without this the goods are stranded: no document is left that can release
      // them and the only way back is a manual stock adjustment.
      expect(after.qualityHold).toBe("0.0000");
      expect(after.available).toBe(addUnits(baseline.available, "12.0000"));
    });
  });

  describe("a completed result", () => {
    it("is corrected by a new inspection rather than edited", async () => {
      const { raised } = await receiveAndRaise(scene.plannedVariantId, 8);
      const inspection = raised!.inspectionId;
      await startInspection(inspection);
      await asTenant(() =>
        inspections().pass(scene.orgId, scene.userId, inspection, `pass-${randomUUID()}`),
      );

      const correction = await asTenant(() =>
        inspections().correct(scene.orgId, scene.userId, inspection, {
          reason: "Sample was drawn from the wrong pallet",
        }),
      );
      expect(correction.correctsInspectionId).toBe(inspection);
      expect(correction.status).toBe("PENDING");
      expect(correction.lines).toHaveLength(1);
      // It holds nothing: the goods were released by the inspection being
      // corrected and may since have been sold, counted or shipped.
      // Read back through the relational `json_agg` path, which renders a
      // numeric as a JSON number and drops the trailing zeros.
      expect(scaled(correction.lines[0]!.heldQuantity)).toBe("0.0000");

      // One correction per mistake, enforced by a partial unique index rather
      // than by a read-then-write check that loses under a race.
      await expect(
        asTenant(() =>
          inspections().correct(scene.orgId, scene.userId, inspection, { reason: "again" }),
        ),
      ).rejects.toThrow();
    });

    it("refuses to correct an inspection that is still open", async () => {
      const { raised } = await receiveAndRaise(scene.plannedVariantId, 3);
      await expect(
        asTenant(() =>
          inspections().correct(scene.orgId, scene.userId, raised!.inspectionId, {
            reason: "too early",
          }),
        ),
      ).rejects.toThrow();
      // Tidy up so the next describe does not inherit a hold.
      await asTenant(() =>
        inspections().cancel(
          scene.orgId,
          scene.userId,
          raised!.inspectionId,
          `cancel-${randomUUID()}`,
        ),
      );
    });
  });

  const firstLineId = async (inspectionId: number): Promise<number> => {
    const [line] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_quality_inspection_lines
        WHERE org_id = ${scene.orgId} AND inspection_id = ${inspectionId} ORDER BY id LIMIT 1`),
    );
    return line!.id;
  };
});

/** Exact, on purpose: these are `numeric(18,4)` and a float comparison is how
 *  this module has been bitten before. */
function addUnits(a: string, b: string): string {
  const total = toScaled(a) + toScaled(b);
  return `${total / 10000n}.${(total % 10000n).toString().padStart(4, "0")}`;
}

/** The column's own rendering, for values that came back through JSON. */
function scaled(value: string): string {
  const total = toScaled(value);
  return `${total / 10000n}.${(total % 10000n).toString().padStart(4, "0")}`;
}

function toScaled(value: string): bigint {
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 10000n + BigInt((frac + "0000").slice(0, 4));
}
