import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { CartonizationService } from "src/modules/inventory/shipments/cartonization.service";
import { PackagesService } from "src/modules/inventory/shipments/packages.service";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { SoFulfillmentService } from "src/modules/inventory/sales-orders/so-fulfillment.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { INV_ERRORS } from "src/modules/inventory/stock-engine/stock-engine.types";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-206 — carton selection.
 *
 * The suite is written to hold the service to what it actually claims: a
 * volumetric and longest-edge check, not three-dimensional packing. The most
 * important probe is the long thin item, because that is the case a naive
 * implementation gets confidently wrong -- multiply three numbers together and
 * a two-metre pole fits in a shoebox.
 */
interface Scene {
  orgId: string;
  userId: string;
  smallItem: number;
  heavyItem: number;
  longItem: number;
  unmeasuredItem: number;
  smallCarton: number;
  largeCarton: number;
  warehouseId: number;
  locationId: number;
}

describe("[seeded-e2e] cartonization", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const carton = () => app.app.get(CartonizationService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** The three availability terms packing must leave exactly where it found them. */
  const bucketsAt = async (locationId: number, variantId: number) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        on_hand: string;
        committed: string;
        outgoing: string;
      }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand,
               COALESCE(SUM(committed), 0)::text AS committed,
               COALESCE(SUM(COALESCE(outgoing_qty, 0)), 0)::text AS outgoing
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId}
           AND product_variant_id = ${variantId}
           AND location_id = ${locationId}`),
    );
    return {
      onHand: Number(row!.on_hand),
      committed: Number(row!.committed),
      outgoing: Number(row!.outgoing),
    };
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("packer", {
        permissionKeys: [
          "inventory:shipments:manage",
          "inventory:packages:manage",
          // The packing queue is a warehouse-scoped list, and a packer with no
          // warehouse sees an empty one — correctly, which would make the queue
          // assertion below pass against a query that returned nothing.
          "inventory:warehouses:scope-all",
          "inventory:stock:read",
          "inventory:stock:adjust",
          "inventory:sales-orders:create",
          "inventory:sales-orders:read",
          "inventory:sales-orders:confirm",
          "inventory:sales-orders:ship",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["packer"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Packed goods', ${`CT-${tag}`}, ${userId})
        RETURNING id`);

      const variant = async (
        name: string,
        w: number | null,
        l: number | null,
        wd: number | null,
        h: number | null,
      ) =>
        (
          await one<{ id: number }>(sql`
            INSERT INTO inv_product_variants
              (org_id, product_id, name, sku, weight_grams, length_mm, width_mm, height_mm)
            VALUES (${seeded.orgId}, ${product.id}, ${name}, ${`CT-${tag}-${name}`},
                    ${w}, ${l}, ${wd}, ${h})
            RETURNING id`)
        ).id;

      const cartonType = async (
        code: string,
        l: number,
        w: number,
        h: number,
        maxG: number,
      ) =>
        (
          await one<{ id: number }>(sql`
            INSERT INTO inv_carton_types
              (org_id, code, name, inner_length_mm, inner_width_mm, inner_height_mm, max_weight_grams)
            VALUES (${seeded.orgId}, ${`${code}${tag}`}, ${code}, ${l}, ${w}, ${h}, ${maxG})
            RETURNING id`)
        ).id;

      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Pack', ${`PK${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`PB${tag}`}, 'BIN') RETURNING id`);

      return {
        orgId: seeded.orgId,
        userId,
        smallItem: await variant("small", 100, 50, 50, 50),
        heavyItem: await variant("heavy", 9000, 50, 50, 50),
        // Long and thin: 1.5 metres, but only 1.5 litres of volume. Volume
        // alone approves it for a 300mm box.
        longItem: await variant("long", 500, 1500, 30, 30),
        unmeasuredItem: await variant("unmeasured", null, null, null, null),
        smallCarton: await cartonType("SMALL", 300, 300, 300, 5000),
        largeCarton: await cartonType("LARGE", 1600, 400, 400, 20000),
        warehouseId: warehouse.id,
        locationId: location.id,
      };
    });

    // Stock to pick against, on the bin every order below reserves from.
    await runInNewTenantTransaction(db, seeded.orgId, () =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `carton-seed-${tag}`,
        sourceType: "cartonization-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.smallItem,
            locationId: scene.locationId,
            quantityDelta: "100.0000",
            unitCost: "1.0000",
          },
          {
            transactionType: "PURCHASE",
            productVariantId: scene.longItem,
            locationId: scene.locationId,
            quantityDelta: "10.0000",
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

  it("recommends the smallest carton that works", async () => {
    // Cheapest box that does the job: shipping air costs money on every parcel.
    const result = await asTenant(() =>
      carton().suggest(scene.orgId, [{ productVariantId: scene.smallItem, quantity: 2 }]),
    );
    expect(result.recommended?.name).toBe("SMALL");
    expect(result.totalWeightGrams).toBe(200);
  });

  it("refuses a carton the contents are too heavy for", async () => {
    // Over its rating a carton fails in transit rather than at the bench, and
    // by then it is somebody else's floor.
    const result = await asTenant(() =>
      carton().suggest(scene.orgId, [{ productVariantId: scene.heavyItem, quantity: 1 }]),
    );
    const small = result.candidates.find((c) => c.name === "SMALL")!;
    expect(small.fits).toBe(false);
    expect(small.reasons.join(" ")).toMatch(/exceeds the 5000g rating/);
    expect(result.recommended?.name).toBe("LARGE");
  });

  it("refuses a long item that fits by volume but not by length", async () => {
    // The case volume alone gets confidently wrong. 1500 x 30 x 30 is 1.35
    // litres against a 27-litre box, so a naive check approves it.
    const result = await asTenant(() =>
      carton().suggest(scene.orgId, [{ productVariantId: scene.longItem, quantity: 1 }]),
    );
    const small = result.candidates.find((c) => c.name === "SMALL")!;
    expect(small.capacityVolumeMm3).toBeGreaterThan(result.totalVolumeMm3);
    expect(small.fits).toBe(false);
    expect(small.reasons.join(" ")).toMatch(/longer than the carton/);
    expect(result.recommended?.name).toBe("LARGE");
  });

  it("declines to recommend anything when an item is unmeasured", async () => {
    // The totals are lower bounds when something has no dimensions, so a
    // recommendation would be a fit computed from data we do not have.
    const result = await asTenant(() =>
      carton().suggest(scene.orgId, [
        { productVariantId: scene.smallItem, quantity: 1 },
        { productVariantId: scene.unmeasuredItem, quantity: 1 },
      ]),
    );
    expect(result.unmeasuredVariantIds).toContain(scene.unmeasuredItem);
    expect(result.recommended).toBeNull();
  });

  it("refuses to accept a carton the contents demonstrably do not fit", async () => {
    await expect(
      asTenant(() =>
        carton().assertFits(scene.orgId, scene.smallCarton, [
          { productVariantId: scene.longItem, quantity: 1 },
        ]),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts a carton the contents do fit", async () => {
    // The control. Without it every refusal above would also pass against a
    // service that rejected everything.
    await expect(
      asTenant(() =>
        carton().assertFits(scene.orgId, scene.smallCarton, [
          { productVariantId: scene.smallItem, quantity: 1 },
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  /**
   * B6 — the bench, end to end.
   *
   * Cartonization existed and nothing called it: no API ever wrote
   * `inv_packages.carton_type_id`, so `assertFits` could not run on any package
   * anybody could create. And packing was a status flip — no scan, no manifest,
   * nothing to reconcile against what the picker actually took off the shelf.
   *
   * The path proven here is the one a packer walks: pick two, scan two into a
   * carton, ask which box they go in, close on that answer. The refusals matter
   * more than the happy path — a third unit nobody picked, and a box the goods
   * demonstrably do not fit.
   */
  describe("scan to carton", () => {
    const packages = () => app.app.get(PackagesService);

    async function pickedOrder(variantId: number, qty: number) {
      const so = await asTenant(() =>
        app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
          orderDate: "2026-08-28",
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
        app.app.get(SoLifecycleService).confirmSo(scene.orgId, soId, scene.userId, `carton-confirm-${soId}`),
      );

      const [soLine] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          SELECT id FROM inv_so_lines WHERE org_id = ${scene.orgId} AND so_id = ${soId}`),
      );

      await asTenant(() =>
        app.app.get(SoFulfillmentService).pickSo(scene.orgId, soId, scene.userId, {
          lines: [
            {
              soLineId: soLine!.id,
              locationId: scene.locationId,
              quantityPicked: `${qty}.0000`,
            },
          ],
        }, `carton-pick-${soId}`),
      );

      return soId;
    }

    const openPackageFor = (soId: number) =>
      asTenant(() => packages().create(scene.orgId, scene.userId, { soId, lines: [] }));

    it("packs what was picked, suggests the box, and closes on it", async () => {
      const soId = await pickedOrder(scene.smallItem, 2);
      const pkg = await openPackageFor(soId);

      // Two scans, one unit each, the way a wedge delivers them.
      for (const attempt of [1, 2]) {
        const state = await asTenant(() =>
          packages().scan(scene.orgId, scene.userId, pkg.id, {
            productVariantId: scene.smallItem,
            quantity: "1",
          }, `carton-scan-1-${randomUUID().slice(0, 8)}`),
        );
        expect(state.packed[0]?.quantity).toBe(`${attempt}.0000`);
      }

      const state = await asTenant(() => packages().reconciliation(scene.orgId, scene.userId, pkg.id));
      expect(state.soId).toBe(soId);
      // Nothing outstanding: the carton holds the order.
      expect(state.outstanding).toEqual([]);

      const suggestion = await asTenant(() =>
        carton().suggest(scene.orgId, [{ productVariantId: scene.smallItem, quantity: 2 }]),
      );
      expect(suggestion.recommended?.name).toBe("SMALL");

      const closed = await asTenant(() =>
        packages().close(scene.orgId, scene.userId, pkg.id, {
          cartonTypeId: suggestion.recommended!.cartonTypeId,
        }),
      );
      expect(closed.status).toBe("CLOSED");
      // Recorded, so a closed parcel can be re-checked. The column had no
      // writer at all before this.
      expect(closed.cartonTypeId).toBe(scene.smallCarton);
    });

    it("refuses the scan that would over-pack the order", async () => {
      // Two picked, two scanned, a third offered. Refused at the bench while
      // the unit is in the packer's hand, not at close with the box taped.
      const soId = await pickedOrder(scene.smallItem, 2);
      const pkg = await openPackageFor(soId);

      for (const _ of [1, 2]) {
        await asTenant(() =>
          packages().scan(scene.orgId, scene.userId, pkg.id, {
            productVariantId: scene.smallItem,
            quantity: "1",
          }, `carton-scan-2-${randomUUID().slice(0, 8)}`),
        );
      }

      await expect(
        asTenant(() =>
          packages().scan(scene.orgId, scene.userId, pkg.id, {
            productVariantId: scene.smallItem,
            quantity: "1",
          }, `carton-scan-3-${randomUUID().slice(0, 8)}`),
        ),
      ).rejects.toThrow(INV_ERRORS.PACKAGE_CONTENT_MISMATCH);

      // And nothing was written on the way to being refused.
      const state = await asTenant(() => packages().reconciliation(scene.orgId, scene.userId, pkg.id));
      expect(state.packed).toEqual([{ productVariantId: scene.smallItem, quantity: "2.0000" }]);
    });

    it("replays a repeated scan rather than counting the item twice", async () => {
      // The retry a handheld actually makes: the scan committed and the reply
      // never came back over the warehouse wifi. Unkeyed, the packer's second
      // press puts a second unit on the manifest for one physical item.
      const soId = await pickedOrder(scene.smallItem, 2);
      const pkg = await openPackageFor(soId);
      const key = `carton-scan-replay-${pkg.id}`;
      const scanOnce = () =>
        asTenant(() =>
          packages().scan(scene.orgId, scene.userId, pkg.id, {
            productVariantId: scene.smallItem,
            quantity: "1",
          }, key),
        );

      const first = await scanOnce();
      const second = await scanOnce();
      expect(second).toEqual(first);
      expect(second.packed).toEqual([{ productVariantId: scene.smallItem, quantity: "1.0000" }]);
    });

    it("refuses a SKU this order never picked", async () => {
      const soId = await pickedOrder(scene.smallItem, 1);
      const pkg = await openPackageFor(soId);

      await expect(
        asTenant(() =>
          packages().scan(scene.orgId, scene.userId, pkg.id, {
            productVariantId: scene.longItem,
            quantity: "1",
          }, `carton-scan-4-${randomUUID().slice(0, 8)}`),
        ),
      ).rejects.toThrow(INV_ERRORS.PACKAGE_CONTENT_MISMATCH);
    });

    it("refuses to close on a carton the contents do not fit", async () => {
      // The long item: 1.5 metres against a 300mm box, and small enough by
      // volume that only the edge check catches it.
      const soId = await pickedOrder(scene.longItem, 1);
      const pkg = await openPackageFor(soId);
      await asTenant(() =>
        packages().scan(scene.orgId, scene.userId, pkg.id, {
          productVariantId: scene.longItem,
          quantity: "1",
        }, `carton-scan-5-${randomUUID().slice(0, 8)}`),
      );

      await expect(
        asTenant(() =>
          packages().close(scene.orgId, scene.userId, pkg.id, { cartonTypeId: scene.smallCarton }),
        ),
      ).rejects.toThrow(/do not fit/);

      // Still open, so the packer can pick a bigger box rather than start again.
      const detail = await asTenant(() => packages().findOne(scene.orgId, scene.userId, pkg.id));
      expect(detail.status).toBe("OPEN");

      await expect(
        asTenant(() =>
          packages().close(scene.orgId, scene.userId, pkg.id, { cartonTypeId: scene.largeCarton }),
        ),
      ).resolves.toMatchObject({ status: "CLOSED" });
    });

    it("resolves a scanned SKU rather than making the packer type an id", async () => {
      const soId = await pickedOrder(scene.smallItem, 1);
      const pkg = await openPackageFor(soId);
      const [variant] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ sku: string }>(sql`
          SELECT sku FROM inv_product_variants
           WHERE org_id = ${scene.orgId} AND id = ${scene.smallItem}`),
      );

      const state = await asTenant(() =>
        packages().scan(scene.orgId, scene.userId, pkg.id, {
          scannedPayload: variant!.sku,
          quantity: "1",
        }, `carton-scan-6-${randomUUID().slice(0, 8)}`),
      );
      expect(state.packed).toEqual([{ productVariantId: scene.smallItem, quantity: "1.0000" }]);
    });

    it("moves no stock", async () => {
      // A package is a document about where the goods are between the shelf and
      // the van. The units left availability when the picker took them.
      const soId = await pickedOrder(scene.smallItem, 1);
      const pkg = await openPackageFor(soId);
      const before = await bucketsAt(scene.locationId, scene.smallItem);

      await asTenant(() =>
        packages().scan(scene.orgId, scene.userId, pkg.id, {
          productVariantId: scene.smallItem,
          quantity: "1",
        }, `carton-scan-7-${randomUUID().slice(0, 8)}`),
      );
      await asTenant(() =>
        packages().close(scene.orgId, scene.userId, pkg.id, { cartonTypeId: scene.smallCarton }),
      );

      expect(await bucketsAt(scene.locationId, scene.smallItem)).toEqual(before);
    });

    it("lists the order on the packing queue with its progress", async () => {
      // Off the cartons and the picked quantities, not off the order's status
      // alone: a status-only queue drops an order the moment somebody starts
      // packing it.
      const soId = await pickedOrder(scene.smallItem, 3);
      const pkg = await openPackageFor(soId);
      await asTenant(() =>
        packages().scan(scene.orgId, scene.userId, pkg.id, {
          productVariantId: scene.smallItem,
          quantity: "1",
        }, `carton-scan-8-${randomUUID().slice(0, 8)}`),
      );

      const queue = await asTenant(() =>
        packages().packingQueue(scene.orgId, scene.userId, { page: 1, limit: 100 }),
      );
      const row = queue.items.find((item) => item.soId === soId);
      expect(row).toBeDefined();
      expect(row!.pickedQuantity).toBe("3.0000");
      expect(row!.packedQuantity).toBe("1.0000");
      expect(row!.openPackageId).toBe(pkg.id);
      expect(row!.fullyPacked).toBe(false);
    });
  });
});
