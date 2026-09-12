import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { availableQty } from "src/modules/inventory/stock-engine/decimal";
import { PickWaveService } from "src/modules/inventory/picking/pick-wave.service";
import { PickConfirmService } from "src/modules/inventory/picking/pick-confirm.service";
import { PickExceptionReportService } from "src/modules/inventory/picking/pick-exception-report.service";
import { PickExceptionService } from "src/modules/inventory/picking/pick-exception.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * B5 — pick exceptions with an owner, `WRONG_LOCATION`, and a substitution that
 * rewrites demand.
 *
 * The suite exists for one fact above all the others, and it is the unit's "done
 * when": **a short pick must not leave the unpicked remainder reserved.** Before
 * this, reporting a shortfall wrote the reason and stopped. The reservation went
 * on holding the whole ordered quantity, `EXPECTED_OUTGOING` clamped to zero
 * against it, and a five-unit line short-picked at two took five units out of
 * availability for ever — three of them on the shelf, unsellable, with nothing
 * anywhere explaining why. No status was wrong and no ledger was unbalanced, so
 * nothing but arithmetic on `inv_stock_levels` can catch it, which is what these
 * tests do.
 */
const PICKER_PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:sales-orders:create",
  "inventory:sales-orders:read",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
  "inventory:picking:substitute",
  "inventory:picking:review",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  supervisorUserId: string;
  variantId: number;
  substituteVariantId: number;
  /** A variant of a product measured in a different UOM. */
  incompatibleVariantId: number;
  warehouseId: number;
  locationId: number;
  otherLocationId: number;
}

interface LevelRow extends Record<string, unknown> {
  on_hand: string;
  committed: string;
  blocked_qty: string | null;
  quality_hold_qty: string | null;
  outgoing_qty: string | null;
}

describe("[seeded-e2e] pick exceptions", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const waves = () => app.app.get(PickWaveService);
  const picks = () => app.app.get(PickConfirmService);
  // B5 split reporting an exception off the confirm path: one records what a
  // picker found, the other what they did not, and only the second unwinds a
  // reservation or rewrites a sales-order line.
  const exceptions = () => app.app.get(PickExceptionReportService);
  const review = () => app.app.get(PickExceptionService);

  /** The projection row for one (variant, location) grain, lot- and serial-free. */
  async function level(variantId: number, locationId: number): Promise<LevelRow> {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<LevelRow>(sql`
        SELECT COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand,
               COALESCE(SUM(committed::numeric), 0)::text AS committed,
               COALESCE(SUM(blocked_qty::numeric), 0)::text AS blocked_qty,
               COALESCE(SUM(quality_hold_qty::numeric), 0)::text AS quality_hold_qty,
               COALESCE(SUM(outgoing_qty::numeric), 0)::text AS outgoing_qty
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId}
           AND product_variant_id = ${variantId}
           AND location_id = ${locationId}
      `),
    );
    return rows[0]!;
  }

  async function reservationsFor(soLineId: number) {
    return asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        id: number;
        product_variant_id: number;
        status: string;
        reserved_qty: string;
      }>(sql`
        SELECT id, product_variant_id, status, reserved_qty
          FROM inv_stock_reservations
         WHERE org_id = ${scene.orgId}
           AND source_type = 'inv_sales_order'
           AND source_line_id = ${String(soLineId)}
         ORDER BY id
      `),
    );
  }

  async function soLineOf(soId: number) {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        id: number;
        product_variant_id: number;
        quantity: string;
        unit_price: string;
        amount: string;
      }>(sql`
        SELECT id, product_variant_id, quantity, unit_price, amount
          FROM inv_so_lines WHERE org_id = ${scene.orgId} AND so_id = ${soId}
      `),
    );
    return rows[0]!;
  }

  async function exceptionRow(pickLineId: number) {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        exception_reason: string | null;
        exception_status: string | null;
        exception_resolution: string | null;
        exception_owner_id: string | null;
        exception_reported_by: string | null;
        exception_location_id: number | null;
        location_id: number | null;
        substitute_variant_id: number | null;
        substitute_quantity: string | null;
      }>(sql`
        SELECT exception_reason, exception_status, exception_resolution,
               exception_owner_id, exception_reported_by, exception_location_id,
               location_id, substitute_variant_id, substitute_quantity
          FROM inv_pick_list_lines
         WHERE org_id = ${scene.orgId} AND id = ${pickLineId}
      `),
    );
    return rows[0]!;
  }

  /** A confirmed single-line order, its wave, and the wave's one task. */
  async function orderOnAWave(
    qty: number,
    variantId: number = scene.variantId,
  ): Promise<{ soId: number; soLineId: number; pickListId: number; lineId: number }> {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-08-29",
        currency: "INR",
        warehouseId: scene.warehouseId,
        lines: [
          {
            productVariantId: variantId,
            quantity: qty,
            unitPrice: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    const soId = (so as { id: number }).id;
    await asTenant(() =>
      app.app
        .get(SoLifecycleService)
        .confirmSo(scene.orgId, soId, scene.userId, `b5-confirm-${soId}`),
    );
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [soId],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    const line = detail.lines[0]!;
    return {
      soId,
      soLineId: Number(line.so_line_id),
      pickListId: wave.pickListId,
      lineId: Number(line.id),
    };
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("picker", { permissionKeys: PICKER_PERMISSIONS })
      .addMember("supervisor", { permissionKeys: PICKER_PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["picker"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const eaches = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      // A second unit of measure, so "five" can be made to mean two different
      // things — which is the whole point of the compatibility gate.
      const kilos = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Kilo ${tag}`}, ${`K${tag}`}, false) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${eaches.id}, 'Exception goods', ${`XC-${tag}`}, ${userId})
        RETURNING id`);
      const weighed = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${kilos.id}, 'Weighed goods', ${`XW-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Ordered', ${`XC-${tag}-V`}) RETURNING id`);
      const substitute = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Substitute', ${`XC-${tag}-S`}) RETURNING id`);
      const incompatible = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${weighed.id}, 'By the kilo', ${`XW-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`XM${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin A', ${`XA${tag}`}, 'BIN') RETURNING id`);
      const otherLocation = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin B', ${`XB${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        supervisorUserId: seeded.members["supervisor"]!.userId,
        variantId: variant.id,
        substituteVariantId: substitute.id,
        incompatibleVariantId: incompatible.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        otherLocationId: otherLocation.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `b5-seed-${tag}`,
        sourceType: "b5-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "2000.0000",
            unitCost: "1.0000",
          },
          {
            transactionType: "PURCHASE",
            productVariantId: scene.substituteVariantId,
            locationId: scene.locationId,
            quantityDelta: "2000.0000",
            unitCost: "1.0000",
          },
          {
            transactionType: "PURCHASE",
            productVariantId: scene.incompatibleVariantId,
            locationId: scene.locationId,
            quantityDelta: "2000.0000",
            unitCost: "1.0000",
          },
        ],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  describe("the reservation on the unpicked remainder", () => {
    it("releases it, so a short pick gives the shelf its stock back", async () => {
      // The unit's "done when", and the defect it closes. Two of five go in the
      // tote; the other three are still on the shelf and this order is never
      // getting them, so they have to become sellable again — and the two in the
      // tote must not.
      const { soLineId, pickListId, lineId } = await orderOnAWave(5);

      const reserved = await level(scene.variantId, scene.locationId);
      const availableWhileReserved = availableQty(reserved);
      expect(
        (await reservationsFor(soLineId)).filter((r) => r.status === "ACTIVE"),
      ).toHaveLength(1);

      await asTenant(() =>
        picks().confirmPick(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, quantityPicked: "2.0000" },
          `b5-short-confirm-${lineId}`,
        ),
      );

      await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "SHORT", notes: "Only two on the shelf" },
          `b5-short-except-${lineId}`,
        ),
      );

      const after = await level(scene.variantId, scene.locationId);
      // Nothing on this line is held by a reservation any more...
      expect(Number(reserved.committed) - Number(after.committed)).toBe(5);
      // ...but the two units standing in a tote are still not for sale, and they
      // are accounted for in the bucket that means exactly that.
      expect(Number(after.outgoing_qty) - Number(reserved.outgoing_qty ?? "0")).toBe(2);
      // The net of the two: three units came back, and only three.
      expect(Number(availableQty(after)) - Number(availableWhileReserved)).toBe(3);

      const held = await reservationsFor(soLineId);
      expect(held).toHaveLength(1);
      expect(held[0]!.status).toBe("RELEASED");
    });

    it("gives the whole quantity back when nothing was picked at all", async () => {
      const { soLineId, pickListId, lineId } = await orderOnAWave(4);
      const before = await level(scene.variantId, scene.locationId);

      await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "NOT_FOUND", notes: "Bin empty" },
          `b5-notfound-${lineId}`,
        ),
      );

      const after = await level(scene.variantId, scene.locationId);
      expect(Number(before.committed) - Number(after.committed)).toBe(4);
      // Nothing went in a tote, so nothing lands in the picked bucket either.
      expect(Number(after.outgoing_qty) - Number(before.outgoing_qty ?? "0")).toBe(0);
      expect(Number(availableQty(after)) - Number(availableQty(before))).toBe(4);
      expect((await reservationsFor(soLineId))[0]!.status).toBe("RELEASED");
    });

    it("does not release twice when the report is retried", async () => {
      // The claim sits around every branch, including the ones that post
      // nothing. A retry that fell through would release a reservation somebody
      // had meanwhile re-created against the same line.
      const { soLineId, pickListId, lineId } = await orderOnAWave(3);
      const key = `b5-retry-${lineId}`;
      const first = await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "SHORT" },
          key,
        ),
      );
      const replayed = await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "SHORT" },
          key,
        ),
      );
      expect(replayed).toEqual(first);
      const held = await reservationsFor(soLineId);
      expect(held.filter((r) => r.status === "RELEASED")).toHaveLength(1);
    });
  });

  describe("WRONG_LOCATION", () => {
    it("retargets the task and keeps the reservation, because the goods exist", async () => {
      // The other four reasons say the units are not coming. This one says the
      // wave sent the picker to the wrong bin, so releasing would hand stock the
      // picker is standing in front of to the next customer.
      const { soLineId, pickListId, lineId } = await orderOnAWave(2);

      const result = await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          {
            pickLineId: lineId,
            reason: "WRONG_LOCATION",
            foundLocationId: scene.otherLocationId,
            notes: "They were one aisle over",
          },
          `b5-wrongloc-${lineId}`,
        ),
      );

      const row = await exceptionRow(lineId);
      expect(row.exception_reason).toBe("WRONG_LOCATION");
      expect(Number(row.exception_location_id)).toBe(scene.otherLocationId);
      expect(Number(row.location_id)).toBe(scene.otherLocationId);

      const held = await reservationsFor(soLineId);
      expect(held.filter((r) => r.status === "ACTIVE")).toHaveLength(1);

      // And the walk is not over: the goods are findable, so the wave stays open
      // rather than closing on a line nobody picked.
      expect(result.waveComplete).toBe(false);
      const wave = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      expect(wave.status).toBe("IN_PROGRESS");
      expect(wave.lines[0]!.line_closed).toBe(false);
    });

    it("refuses a bin in another warehouse", async () => {
      const { pickListId, lineId } = await orderOnAWave(1);
      const [foreign] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          INSERT INTO inv_warehouses (org_id, name, code, created_by)
          VALUES (${scene.orgId}, 'Far', ${`FR${randomUUID().slice(0, 6)}`}, ${scene.userId})
          RETURNING id`),
      );
      const [bin] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${scene.orgId}, ${Number(foreign!.id)}, 'Far bin', ${`FB${randomUUID().slice(0, 6)}`}, 'BIN')
          RETURNING id`),
      );
      await expect(
        asTenant(() =>
          exceptions().reportException(
            scene.orgId,
            scene.userId,
            pickListId,
            {
              pickLineId: lineId,
              reason: "WRONG_LOCATION",
              foundLocationId: Number(bin!.id),
            },
            `b5-wrongloc-foreign-${lineId}`,
          ),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("substitution rewrites demand", () => {
    it("moves the order line and leaves exactly one reservation, on the new SKU", async () => {
      const { soId, soLineId, pickListId, lineId } = await orderOnAWave(6);
      const originalLine = await soLineOf(soId);
      expect(Number(originalLine.product_variant_id)).toBe(scene.variantId);

      await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          {
            pickLineId: lineId,
            reason: "SUBSTITUTED",
            substituteVariantId: scene.substituteVariantId,
            quantityPicked: "6.0000",
          },
          `b5-sub-${lineId}`,
        ),
      );

      // The order now asks for what is actually going to leave the building.
      const rewritten = await soLineOf(soId);
      expect(Number(rewritten.product_variant_id)).toBe(scene.substituteVariantId);
      // And it asks for it on the same commercial terms: a warehouse swap is not
      // a renegotiation.
      expect(rewritten.quantity).toBe(originalLine.quantity);
      expect(rewritten.unit_price).toBe(originalLine.unit_price);
      expect(rewritten.amount).toBe(originalLine.amount);

      // The "done when": one reservation, on the new SKU.
      const held = await reservationsFor(soLineId);
      const active = held.filter((r) => r.status === "ACTIVE");
      expect(active).toHaveLength(1);
      expect(Number(active[0]!.product_variant_id)).toBe(scene.substituteVariantId);
      expect(held.filter((r) => r.status === "RELEASED")).toHaveLength(1);

      // Evidence of source and target survives on the row.
      const row = await exceptionRow(lineId);
      expect(row.exception_reason).toBe("SUBSTITUTED");
      expect(Number(row.substitute_variant_id)).toBe(scene.substituteVariantId);
      expect(row.substitute_quantity).toBe("6.0000");
    });

    it("subtracts the swapped-in units exactly once", async () => {
      // `committed` from the new reservation and `outgoing_qty` from the
      // substitute column are disjoint by construction only while both stand on
      // the same projection row — this is the assertion that catches them
      // drifting onto two.
      const before = await level(scene.substituteVariantId, scene.locationId);
      const { pickListId, lineId } = await orderOnAWave(7);

      await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          {
            pickLineId: lineId,
            reason: "SUBSTITUTED",
            substituteVariantId: scene.substituteVariantId,
            quantityPicked: "7.0000",
          },
          `b5-sub-once-${lineId}`,
        ),
      );

      const after = await level(scene.substituteVariantId, scene.locationId);
      expect(Number(availableQty(before)) - Number(availableQty(after))).toBe(7);
    });

    it("refuses a substitute measured in a different unit", async () => {
      // "Five" on the line would silently start meaning five kilos.
      const { pickListId, lineId } = await orderOnAWave(2);
      await expect(
        asTenant(() =>
          exceptions().reportException(
            scene.orgId,
            scene.userId,
            pickListId,
            {
              pickLineId: lineId,
              reason: "SUBSTITUTED",
              substituteVariantId: scene.incompatibleVariantId,
              quantityPicked: "2.0000",
            },
            `b5-sub-uom-${lineId}`,
          ),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses to swap a line that already has some of the original in a tote", async () => {
      // An identity is not divisible: half-picked and half-substituted would have
      // to become two lines with two prices, which nobody at a shelf decides.
      const { pickListId, lineId } = await orderOnAWave(4);
      await asTenant(() =>
        picks().confirmPick(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, quantityPicked: "1.0000" },
          `b5-sub-partial-confirm-${lineId}`,
        ),
      );
      await expect(
        asTenant(() =>
          exceptions().reportException(
            scene.orgId,
            scene.userId,
            pickListId,
            {
              pickLineId: lineId,
              reason: "SUBSTITUTED",
              substituteVariantId: scene.substituteVariantId,
              quantityPicked: "3.0000",
            },
            `b5-sub-partial-${lineId}`,
          ),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("owner, status and review", () => {
    it("gives every exception an owner, and it is the person who planned the walk", async () => {
      const { pickListId, lineId } = await orderOnAWave(1);
      const result = await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "SHORT" },
          `b5-owner-${lineId}`,
        ),
      );
      expect(result.ownerUserId).toBe(scene.userId);
      expect(result.status).toBe("OPEN");

      const row = await exceptionRow(lineId);
      expect(row.exception_owner_id).toBe(scene.userId);
      expect(row.exception_reported_by).toBe(scene.userId);
      expect(row.exception_status).toBe("OPEN");

      const reassigned = await asTenant(() =>
        review().assign(scene.orgId, scene.userId, lineId, {
          ownerUserId: scene.supervisorUserId,
        }),
      );
      expect(reassigned.ownerUserId).toBe(scene.supervisorUserId);
      expect((await exceptionRow(lineId)).exception_owner_id).toBe(scene.supervisorUserId);
    });

    it("holds a damaged line's wave open until somebody signs it off", async () => {
      // "Unresolved can block wave complete where required." A write-off is not
      // a decision a picker takes at a shelf, so the wave waits for one.
      const { pickListId, lineId } = await orderOnAWave(2);
      const reported = await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "DAMAGED", notes: "Crushed carton" },
          `b5-damaged-${lineId}`,
        ),
      );
      expect(reported.waveComplete).toBe(false);

      const resolved = await asTenant(() =>
        review().resolve(scene.orgId, scene.supervisorUserId, lineId, {
          resolution: "ACCEPTED",
          notes: "Written off, customer told",
        }),
      );
      expect(resolved.waveComplete).toBe(true);

      const wave = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      expect(wave.status).toBe("COMPLETED");
      const row = await exceptionRow(lineId);
      expect(row.exception_status).toBe("RESOLVED");
      expect(row.exception_resolution).toBe("ACCEPTED");
    });

    it("lets a shortfall close its own wave, because there is nothing to decide", async () => {
      const { pickListId, lineId } = await orderOnAWave(2);
      const reported = await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "SHORT" },
          `b5-short-closes-${lineId}`,
        ),
      );
      expect(reported.waveComplete).toBe(true);
    });

    it("refuses a second review of the same exception", async () => {
      const { pickListId, lineId } = await orderOnAWave(1);
      await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "DAMAGED" },
          `b5-double-review-${lineId}`,
        ),
      );
      await asTenant(() =>
        review().resolve(scene.orgId, scene.supervisorUserId, lineId, {
          resolution: "ACCEPTED",
          notes: "Signed",
        }),
      );
      await expect(
        asTenant(() =>
          review().resolve(scene.orgId, scene.supervisorUserId, lineId, {
            resolution: "REJECTED",
            notes: "Changed my mind",
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("lists open exceptions and says which of them is holding a wave", async () => {
      const { pickListId, lineId } = await orderOnAWave(2);
      await asTenant(() =>
        exceptions().reportException(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId: lineId, reason: "DAMAGED", notes: "Split bag" },
          `b5-queue-${lineId}`,
        ),
      );

      const queue = await asTenant(() =>
        review().list(scene.orgId, scene.userId, {
          page: 1,
          limit: 100,
          status: "OPEN",
          ownership: "ANY",
        }),
      );
      const mine = queue.items.find((item) => item.pickLineId === lineId);
      expect(mine).toBeDefined();
      expect(mine!.reason).toBe("DAMAGED");
      expect(mine!.status).toBe("OPEN");
      expect(mine!.ownerUserId).toBe(scene.userId);
      expect(mine!.pickListId).toBe(pickListId);
      // The point of the column: not "here are some exceptions" but "here is the
      // one a picker is standing still for".
      expect(mine!.blocksWave).toBe(true);
      expect(queue.openCount).toBeGreaterThan(0);
    });
  });
});
