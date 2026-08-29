import { randomUUID } from "node:crypto";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { SoFulfillmentService } from "src/modules/inventory/sales-orders/so-fulfillment.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { INVENTORY_COMMAND_EVENTS } from "src/modules/inventory/stock-engine/command-events";
import { PickWaveService } from "src/modules/inventory/picking/pick-wave.service";
import { PickConfirmService } from "src/modules/inventory/picking/pick-confirm.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { outboxEventsFor } from "test/helpers/outbox-events";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-204 — picking waves.
 *
 * The existing pick path records what was picked, one order at a time, after
 * the fact. A picker walking the same aisle four times because four orders each
 * wanted one item from it is the cost this ticket removes.
 *
 * This suite also proves the new module boots. A service whose module never
 * imported the provider it injects type-checks perfectly and fails only at
 * runtime, which this repository has shipped before.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:sales-orders:create",
  "inventory:sales-orders:read",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  /** A second picker, for the claim / abandon / reassign cases. */
  reliefUserId: string;
  productId: number;
  variantId: number;
  variantSku: string;
  substituteVariantId: number;
  retiredProductId: number;
  retiredVariantId: number;
  warehouseId: number;
  locationId: number;
}

describe("[seeded-e2e] picking waves", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  async function confirmedOrder(qty: number): Promise<number> {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-08-28",
        currency: "INR",
        warehouseId: scene.warehouseId,
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: qty,
            unitPrice: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    const id = (so as { id: number }).id;
    await asTenant(() =>
      app.app.get(SoLifecycleService).confirmSo(scene.orgId, id, scene.userId, `confirm-${id}`),
    );
    return id;
  }

  const waves = () => app.app.get(PickWaveService);
  const picks = () => app.app.get(PickConfirmService);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("picker", { permissionKeys: PERMISSIONS })
      .addMember("relief", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["picker"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Picked goods', ${`PK-${tag}`}, ${userId})
        RETURNING id`);
      const sku = `PK-${tag}-V`;
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${sku}) RETURNING id`);
      const substitute = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Substitute', ${`${sku}-SUB`}) RETURNING id`);
      const retiredProduct = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, status, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Retired goods', ${`PK-${tag}-R`}, 'DISCONTINUED', ${userId})
        RETURNING id`);
      const retiredVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${retiredProduct.id}, 'Retired', ${`PK-${tag}-RV`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Bin', ${`B1${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        reliefUserId: seeded.members["relief"]!.userId,
        productId: product.id,
        variantId: variant.id,
        variantSku: sku,
        substituteVariantId: substitute.id,
        retiredProductId: retiredProduct.id,
        retiredVariantId: retiredVariant.id,
        warehouseId: warehouse.id,
        locationId: location.id,
      };
    });

    // Stock to pick against.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `wave-seed-${tag}`,
        sourceType: "wave-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "500.0000",
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

  it("gathers several orders into one pick list", async () => {
    const a = await confirmedOrder(3);
    const b = await confirmedOrder(4);

    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a, b],
      }),
    );

    expect(wave.orderCount).toBe(2);
    expect(wave.lineCount).toBe(2);

    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    // Null soId on the header is what distinguishes a wave from a single-order
    // pick; each line still knows which order it belongs to, so packing can
    // split the goods back.
    expect(detail.soId).toBeNull();
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines.every((l) => l.so_line_id !== null)).toBe(true);
    expect(detail.status).toBe("PENDING");
  });

  it("refuses a wave containing an order that is not ready", async () => {
    const ready = await confirmedOrder(1);
    const draft = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-08-28",
        currency: "INR",
        warehouseId: scene.warehouseId,
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: 1,
            unitPrice: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );

    await expect(
      asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [ready, (draft as { id: number }).id],
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("confirms a line when the scan matches, and completes the wave", async () => {
    const a = await confirmedOrder(2);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    const line = detail.lines[0]!;

    const result = await asTenant(() =>
      picks().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
        pickLineId: line.id,
        quantityPicked: "2.0000",
        locationId: scene.locationId,
        scannedPayload: scene.variantSku,
      }, `wave-confirmPick-1`),
    );

    expect(result.quantityPicked).toBe("2.0000");
    expect(result.waveComplete).toBe(true);
  });

  it("takes wave-picked units out of availability", async () => {
    // A1/A2. `confirmPick` wrote `quantity_picked` and nothing else, so units
    // already in a tote were still offered to the next customer — the single
    // order pick path maintained `outgoing_qty` and this one did not. The
    // reconciliation report named it as `outgoing_vs_picks` drift, which is how
    // it was found.
    //
    // Picked from a *second* bin on purpose. `committed` and `outgoing_qty` are
    // disjoint by construction — only the part no reservation covers is added —
    // so a pick from the bin the order reserved could leave the bucket at zero
    // legitimately, and the assertion would hold whether or not the writer ran.
    // No reservation sits on this bin, so every picked unit has to land here.
    const db = () => app.app.get<Db>(DRIZZLE);
    const suffix = randomUUID().slice(0, 6);
    const [spare] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${scene.orgId}, ${scene.warehouseId}, 'Overflow', ${`OVF${suffix}`}, 'BIN')
        RETURNING id`),
    );
    const spareId = spare!.id;

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `wave-outgoing-${suffix}`,
        sourceType: "picking-waves-fixture",
        sourceId: suffix,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: spareId,
            quantityDelta: "10.0000",
            unitCost: "1.0000",
          },
        ],
      }),
    );

    const bucketsAt = async (locationId: number) => {
      const [row] = await asTenant(() =>
        db().execute<{ committed: string; outgoing: string }>(sql`
          SELECT COALESCE(SUM(committed), 0)::text AS committed,
                 COALESCE(SUM(COALESCE(outgoing_qty, 0)), 0)::text AS outgoing
          FROM inv_stock_levels
          WHERE org_id = ${scene.orgId}
            AND product_variant_id = ${scene.variantId}
            AND location_id = ${locationId}`),
      );
      return { committed: Number(row!.committed), outgoing: Number(row!.outgoing) };
    };

    const before = await bucketsAt(spareId);
    expect(before.committed).toBe(0);
    expect(before.outgoing).toBe(0);

    const order = await confirmedOrder(3);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [order],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );

    await asTenant(() =>
      picks().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
        pickLineId: detail.lines[0]!.id,
        quantityPicked: "3.0000",
        locationId: spareId,
      }, `wave-confirmPick-2`),
    );

    const after = await bucketsAt(spareId);
    expect(after.outgoing).toBe(3);
    // Availability at that bin drops by exactly the picked quantity: the goods
    // are on the shelf but spoken for.
    const [level] = await asTenant(() =>
      db().execute<{ available: string }>(sql`
        SELECT (on_hand::numeric - committed::numeric
                - COALESCE(blocked_qty, 0)::numeric
                - COALESCE(quality_hold_qty, 0)::numeric
                - COALESCE(outgoing_qty, 0)::numeric)::text AS available
        FROM inv_stock_levels
        WHERE org_id = ${scene.orgId}
          AND product_variant_id = ${scene.variantId}
          AND location_id = ${spareId}`),
    );
    expect(Number(level!.available)).toBe(7);

    // A1/A2. Cancelling sends the tote back to the shelf. Releasing the
    // reservations used to be the only unwind, so picked-then-cancelled units
    // stayed in `outgoing_qty` for good — permanently unsellable stock with no
    // live document left to explain why.
    await asTenant(() =>
      app.app.get(SoLifecycleService).cancelSo(scene.orgId, order, scene.userId),
    );
    const cancelled = await bucketsAt(spareId);
    expect(cancelled.outgoing).toBe(0);
  });

  it("refuses a confirmation whose scan is a different product", async () => {
    // The reason this check lives on the server: the screen is showing the
    // task, so it agrees with itself whatever is actually in the picker's hand.
    const a = await confirmedOrder(1);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );

    await expect(
      asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
          pickLineId: detail.lines[0]!.id,
          quantityPicked: "1.0000",
          scannedPayload: "SOME-OTHER-SKU-THAT-IS-NOT-THIS",
        }, `wave-confirmPick-3`),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses picking more than the line asks for", async () => {
    const a = await confirmedOrder(1);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );

    await expect(
      asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
          pickLineId: detail.lines[0]!.id,
          quantityPicked: "2.0000",
        }, `wave-confirmPick-4`),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("accumulates partial picks exactly rather than by float", async () => {
    // Three thirds of one unit must close the line, and must not overshoot it.
    const a = await confirmedOrder(1);
    const wave = await asTenant(() =>
      waves().createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [a],
      }),
    );
    const detail = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    const lineId = detail.lines[0]!.id;

    // A key per attempt, as a real client sends. Reusing one across the three
    // partial picks would be correct behaviour producing a wrong test: the
    // second call carries an identical body and would legitimately *replay*
    // rather than pick, and the third would be refused as the same key with a
    // different request.
    for (const [index, part] of ["0.3333", "0.3333", "0.3334"].entries()) {
      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
          pickLineId: lineId,
          quantityPicked: part,
        }, `wave-partial-${wave.pickListId}-${index}`),
      );
    }

    const after = await asTenant(() =>
      waves().getWave(scene.orgId, scene.userId, wave.pickListId),
    );
    expect(after.lines[0]!.quantity_picked).toBe("1.0000");
    expect(after.status).toBe("COMPLETED");
  });

  describe("INV-205 exceptions and substitution", () => {
    async function oneLineWave() {
      const so = await confirmedOrder(5);
      const wave = await asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [so],
        }),
      );
      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, wave.pickListId),
      );
      return { pickListId: wave.pickListId, lineId: detail.lines[0]!.id };
    }

    it("lets a short-picked wave finish once the shortfall is explained", async () => {
      // Without this a picker holding a tote the system will not let them close
      // is stuck, which is exactly what an exception exists to resolve.
      const { pickListId, lineId } = await oneLineWave();
      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          quantityPicked: "2.0000",
        }, `wave-confirmPick-6`),
      );

      const open = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      expect(open.status).toBe("IN_PROGRESS");

      const result = await asTenant(() =>
        picks().reportException(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          reason: "SHORT",
          notes: "Only two on the shelf",
        }, `wave-reportException-7`),
      );
      expect(result.waveComplete).toBe(true);
    });

    it("keeps why apart from how much", async () => {
      // A line short because the shelf was empty and a line short because the
      // picker moved on carry the same quantity and different meanings.
      const { pickListId, lineId } = await oneLineWave();
      await asTenant(() =>
        picks().reportException(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          reason: "NOT_FOUND",
          notes: "Bin empty",
        }, `wave-reportException-8`),
      );

      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ exception_reason: string; exception_notes: string }>(sql`
          SELECT exception_reason, exception_notes FROM inv_pick_list_lines
          WHERE org_id = ${scene.orgId} AND id = ${lineId}`),
      );
      expect(row!.exception_reason).toBe("NOT_FOUND");
      expect(row!.exception_notes).toBe("Bin empty");
      expect(detail.status).toBe("COMPLETED");
    });

    it("records what actually went in the tote on a substitution", async () => {
      const { pickListId, lineId } = await oneLineWave();
      const result = await asTenant(() =>
        picks().reportException(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          reason: "SUBSTITUTED",
          substituteVariantId: scene.substituteVariantId,
          quantityPicked: "5.0000",
        }, `wave-reportException-9`),
      );
      expect(result.substituteVariantId).toBe(scene.substituteVariantId);
      expect(result.substituteQuantity).toBe("5.0000");
    });

    it("does not count a substitute as units of the original SKU", async () => {
      // The line names the original variant. Folding the substitute into
      // quantity_picked made packing -- which keys its map on
      // product_variant_id -- believe those units of the original were in the
      // tote: it would accept a package of the original and reject one holding
      // what the picker actually took.
      const { pickListId, lineId } = await oneLineWave();
      await asTenant(() =>
        picks().reportException(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          reason: "SUBSTITUTED",
          substituteVariantId: scene.substituteVariantId,
          quantityPicked: "5.0000",
        }, `wave-reportException-10`),
      );

      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{
          quantity_picked: string;
          substitute_quantity: string;
          substitute_variant_id: number;
        }>(sql`
          SELECT quantity_picked, substitute_quantity, substitute_variant_id
          FROM inv_pick_list_lines
          WHERE org_id = ${scene.orgId} AND id = ${lineId}`),
      );
      expect(row!.quantity_picked).toBe("0.0000");
      expect(row!.substitute_quantity).toBe("5.0000");
      expect(row!.substitute_variant_id).toBe(scene.substituteVariantId);
    });

    it("still refuses a substitution larger than the line asks for", async () => {
      // Separating the columns must not turn the bound into a licence.
      const { pickListId, lineId } = await oneLineWave();
      await expect(
        asTenant(() =>
          picks().reportException(scene.orgId, scene.userId, pickListId, {
            pickLineId: lineId,
            reason: "SUBSTITUTED",
            substituteVariantId: scene.substituteVariantId,
            quantityPicked: "99.0000",
          }, `wave-reportException-11`),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses to substitute in a discontinued product", async () => {
      // Swapping at the shelf must not route around the catalogue gate a sales
      // order line is held to.
      const { pickListId, lineId } = await oneLineWave();
      await expect(
        asTenant(() =>
          picks().reportException(scene.orgId, scene.userId, pickListId, {
            pickLineId: lineId,
            reason: "SUBSTITUTED",
            substituteVariantId: scene.retiredVariantId,
            quantityPicked: "1.0000",
          }, `wave-reportException-12`),
        ),
      ).rejects.toThrow();
    });

    it("refuses a substitution that names the same product", async () => {
      const { pickListId, lineId } = await oneLineWave();
      await expect(
        asTenant(() =>
          picks().reportException(scene.orgId, scene.userId, pickListId, {
            pickLineId: lineId,
            reason: "SUBSTITUTED",
            substituteVariantId: scene.variantId,
            quantityPicked: "1.0000",
          }, `wave-reportException-13`),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  /**
   * B4 — the three facts a confirmed pick is supposed to move.
   *
   * Before this unit, confirming a wave line wrote `quantity_picked` and
   * recomputed `outgoing_qty`, and stopped there: the reservation holding those
   * units stayed ACTIVE, and the sales order stayed in whatever status it had
   * before anybody walked anywhere — so `packSo`, which requires PICKED, refused
   * to pack goods the picker was holding.
   */
  describe("stock, reservation and order all move on confirm", () => {
    /**
     * Each case gets its own variant, its own bin and its own stock.
     *
     * Not fastidiousness: `EXPECTED_OUTGOING` is
     * `GREATEST(0, picked - shipped - committed)` **at the grain**, so on a bin
     * shared with a dozen other orders the bucket sits clamped at zero and a
     * six-unit hand-off is invisible in it. The arithmetic these tests are about
     * is only legible where the bin holds nothing else — and an isolated bin is
     * also the only way the reservation is guaranteed to land where the
     * assertions look, since the allocator ranks every eligible row.
     */
    async function isolatedOrder(qty: number) {
      const suffix = randomUUID().slice(0, 6);
      const db = app.app.get<Db>(DRIZZLE);
      const fixture = await asTenant(async () => {
        const [variant] = await db.execute<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${scene.orgId}, ${scene.productId}, 'Isolated', ${`ISO-${suffix}`})
          RETURNING id`);
        const [location] = await db.execute<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${scene.orgId}, ${scene.warehouseId}, 'Isolated bin', ${`ISO${suffix}`}, 'BIN')
          RETURNING id`);
        return { variantId: variant!.id, locationId: location!.id };
      });

      await asTenant(() =>
        app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
          idempotencyKey: `wave-iso-seed-${suffix}`,
          sourceType: "picking-waves-fixture",
          sourceId: suffix,
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: fixture.variantId,
              locationId: fixture.locationId,
              quantityDelta: "100.0000",
              unitCost: "1.0000",
            },
          ],
        }),
      );

      const so = await asTenant(() =>
        app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
          orderDate: "2026-08-28",
          currency: "INR",
          warehouseId: scene.warehouseId,
          lines: [
            {
              productVariantId: fixture.variantId,
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
        app.app.get(SoLifecycleService).confirmSo(scene.orgId, soId, scene.userId, `confirm-${soId}`),
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

      return {
        ...fixture,
        soId,
        suffix,
        pickListId: wave.pickListId,
        line: detail.lines[0]!,
        unallocatedLines: wave.unallocatedLines,
      };
    }

    const bucketsAt = async (locationId: number, variantId: number) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{
          committed: string;
          outgoing: string;
          available: string;
        }>(sql`
          SELECT COALESCE(SUM(committed), 0)::text AS committed,
                 COALESCE(SUM(COALESCE(outgoing_qty, 0)), 0)::text AS outgoing,
                 COALESCE(SUM(on_hand::numeric - committed::numeric
                              - COALESCE(blocked_qty, 0)::numeric
                              - COALESCE(quality_hold_qty, 0)::numeric
                              - COALESCE(outgoing_qty, 0)::numeric), 0)::text AS available
            FROM inv_stock_levels
           WHERE org_id = ${scene.orgId}
             AND product_variant_id = ${variantId}
             AND location_id = ${locationId}`),
      );
      return {
        committed: Number(row!.committed),
        outgoing: Number(row!.outgoing),
        available: Number(row!.available),
      };
    };

    const soStatus = async (soId: number) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ status: string }>(sql`
          SELECT status FROM inv_sales_orders
           WHERE org_id = ${scene.orgId} AND id = ${soId}`),
      );
      return row!.status;
    };

    const reservationStates = async (soId: number) => {
      const rows = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ status: string }>(sql`
          SELECT status FROM inv_stock_reservations
           WHERE org_id = ${scene.orgId}
             AND source_type = 'inv_sales_order'
             AND source_id = ${String(soId)}`),
      );
      return rows.map((r) => r.status);
    };

    it("allocates every wave line to the bin the order already reserved", async () => {
      // B4, item 1. Lines used to be inserted with a null location, so the walk
      // had no order, and -- worse -- a confirm had no projection grain to write
      // to and left the picked units sellable. Reservation first, because
      // sending the picker anywhere else splits `committed` from `outgoing_qty`
      // across two bins and subtracts availability twice for one set of units.
      const iso = await isolatedOrder(2);
      expect(iso.unallocatedLines).toBe(0);
      expect(iso.line.location_id).toBe(iso.locationId);
    });

    it("hands the reserved units to the picked bucket, consumes the reservation, and moves the order", async () => {
      const iso = await isolatedOrder(6);

      expect(await soStatus(iso.soId)).toBe("RESERVED");
      expect(await reservationStates(iso.soId)).toEqual(["ACTIVE"]);
      const before = await bucketsAt(iso.locationId, iso.variantId);
      expect(before.committed).toBe(6);
      expect(before.outgoing).toBe(0);

      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, iso.pickListId, {
          pickLineId: iso.line.id,
          quantityPicked: "6.0000",
        }, `wave-handoff-${iso.pickListId}`),
      );

      const after = await bucketsAt(iso.locationId, iso.variantId);
      // The hand-off: out of `committed`, into `outgoing_qty`. Both, and in that
      // order -- recomputing the outgoing bucket before releasing the
      // reservation reads a world where it still covers the units and writes
      // zero, and the goods in the tote become sellable again.
      expect(after.committed).toBe(0);
      expect(after.outgoing).toBe(6);
      // Which is the whole point of the two buckets being disjoint: the units
      // leave availability exactly once, and they were already gone.
      expect(after.available).toBe(before.available);

      expect(await reservationStates(iso.soId)).toEqual(["CONSUMED"]);
      expect(await soStatus(iso.soId)).toBe("PICKED");
    });

    it("subtracts a pick from an unreserved bin exactly once", async () => {
      // The defect consuming the reservation removes. Reserved at one bin,
      // picked from another: `committed` used to stay stranded on the reserved
      // bin while `outgoing_qty` rose on the picked one, so five units left
      // availability twice.
      const iso = await isolatedOrder(5);
      const [spare] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
          VALUES (${scene.orgId}, ${scene.warehouseId}, 'Second bin', ${`SEC${iso.suffix}`}, 'BIN')
          RETURNING id`),
      );
      const spareId = spare!.id;
      await asTenant(() =>
        app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
          idempotencyKey: `wave-second-bin-${iso.suffix}`,
          sourceType: "picking-waves-fixture",
          sourceId: iso.suffix,
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: iso.variantId,
              locationId: spareId,
              quantityDelta: "20.0000",
              unitCost: "1.0000",
            },
          ],
        }),
      );

      const reservedBefore = await bucketsAt(iso.locationId, iso.variantId);
      const spareBefore = await bucketsAt(spareId, iso.variantId);

      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, iso.pickListId, {
          pickLineId: iso.line.id,
          quantityPicked: "5.0000",
          locationId: spareId,
        }, `wave-second-bin-pick-${iso.pickListId}`),
      );

      const reservedAfter = await bucketsAt(iso.locationId, iso.variantId);
      const spareAfter = await bucketsAt(spareId, iso.variantId);

      // The reserved bin gets its promise back...
      expect(reservedAfter.committed).toBe(reservedBefore.committed - 5);
      expect(reservedAfter.available).toBe(reservedBefore.available + 5);
      // ...and the bin the goods actually came off loses them, once.
      expect(spareAfter.outgoing).toBe(spareBefore.outgoing + 5);
      expect(spareAfter.available).toBe(spareBefore.available - 5);
    });

    it("replays the same key rather than picking twice", async () => {
      const iso = await isolatedOrder(4);
      const key = `wave-replay-${iso.pickListId}`;
      const call = () =>
        asTenant(() =>
          picks().confirmPick(scene.orgId, scene.userId, iso.pickListId, {
            pickLineId: iso.line.id,
            quantityPicked: "4.0000",
          }, key),
        );

      const first = await call();
      const after = await bucketsAt(iso.locationId, iso.variantId);
      expect(after.outgoing).toBe(4);

      const second = await call();
      expect(second).toEqual(first);

      // Nothing moved the second time: not the quantity, not the bucket, not the
      // reservation. A replay that re-ran the hand-off would release `committed`
      // a second time and re-offer stock standing in a tote.
      expect(await bucketsAt(iso.locationId, iso.variantId)).toEqual(after);
      expect(await reservationStates(iso.soId)).toEqual(["CONSUMED"]);

      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, iso.pickListId),
      );
      expect(detail.lines[0]!.quantity_picked).toBe("4.0000");
    });

    it("announces the completed walk once", async () => {
      const iso = await isolatedOrder(2);
      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, iso.pickListId, {
          pickLineId: iso.line.id,
          quantityPicked: "2.0000",
        }, `wave-event-${iso.pickListId}`),
      );

      const events = await asTenant(() =>
        outboxEventsFor(
          app.app.get<Db>(DRIZZLE),
          scene.orgId,
          INVENTORY_COMMAND_EVENTS.PICK_COMPLETED,
          String(iso.pickListId),
        ),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.aggregateType).toBe("inv_pick_list");
      expect(events[0]!.payload.pickListId).toBe(iso.pickListId);
    });

    it("ships a wave-picked order off the wave's own pick lines", async () => {
      // `inv_pick_lists.so_id` is null for a wave, so shipping used to find no
      // pick list and fall back to the reservations -- which picking has now
      // consumed. Without the lookup going through `so_line_id`, a wave-picked
      // order could not be shipped at all.
      const iso = await isolatedOrder(3);
      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, iso.pickListId, {
          pickLineId: iso.line.id,
          quantityPicked: "3.0000",
        }, `wave-ship-pick-${iso.pickListId}`),
      );

      const beforeShip = await bucketsAt(iso.locationId, iso.variantId);
      expect(beforeShip.outgoing).toBe(3);

      await asTenant(() =>
        app.app.get(SoFulfillmentService).shipSo(
          scene.orgId,
          iso.soId,
          scene.userId,
          `wave-ship-${iso.soId}`,
          { shipDate: "2026-08-28" },
        ),
      );

      const afterShip = await bucketsAt(iso.locationId, iso.variantId);
      // The goods leave the building here and nowhere earlier: the tote empties
      // and on-hand falls by the same three units, so availability is unchanged.
      expect(afterShip.outgoing).toBe(0);
      expect(afterShip.available).toBe(beforeShip.available);
      expect(await soStatus(iso.soId)).toBe("SHIPPED");
    });
  });

  /** B4, item 3 — a wave is a walk somebody is doing. */
  describe("claim, abandon, reassign", () => {
    async function unclaimedWave() {
      const soId = await confirmedOrder(2);
      const wave = await asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [soId],
        }),
      );
      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, wave.pickListId),
      );
      return { pickListId: wave.pickListId, lineId: detail.lines[0]!.id };
    }

    it("gives the wave to the first picker and refuses the second", async () => {
      // The double count this prevents is physical before it is ever numeric.
      // Each confirm is already bounded by `quantity_to_pick`, so the second
      // picker's confirm is refused — but only after they have walked the aisle
      // and taken the goods off the shelf.
      const { pickListId } = await unclaimedWave();

      const mine = await asTenant(() =>
        waves().claimWave(scene.orgId, scene.userId, pickListId),
      );
      expect(mine.claimed).toBe(true);

      await expect(
        asTenant(() =>
          waves().claimWave(scene.orgId, scene.reliefUserId, pickListId),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("treats a repeated claim by the holder as the same claim", async () => {
      // Retrying a claim is what a flaky warehouse network produces, and it must
      // not read as somebody else holding the wave.
      const { pickListId } = await unclaimedWave();
      await asTenant(() => waves().claimWave(scene.orgId, scene.userId, pickListId));
      const again = await asTenant(() =>
        waves().claimWave(scene.orgId, scene.userId, pickListId),
      );
      expect(again.claimed).toBe(false);
      expect(again.assignedTo).toBe(scene.userId);
    });

    it("refuses a confirm from anyone but the holder, and claims on first confirm", async () => {
      const { pickListId, lineId } = await unclaimedWave();

      // Confirming an unclaimed wave claims it, so the common case needs no
      // separate call.
      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          quantityPicked: "1.0000",
        }, `wave-autoclaim-${pickListId}`),
      );

      await expect(
        asTenant(() =>
          picks().confirmPick(scene.orgId, scene.reliefUserId, pickListId, {
            pickLineId: lineId,
            quantityPicked: "1.0000",
          }, `wave-autoclaim-intruder-${pickListId}`),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("hands a wave back, and on to somebody else, without moving a quantity", async () => {
      const { pickListId, lineId } = await unclaimedWave();
      await asTenant(() =>
        picks().confirmPick(scene.orgId, scene.userId, pickListId, {
          pickLineId: lineId,
          quantityPicked: "1.0000",
        }, `wave-handback-${pickListId}`),
      );

      const pickedBefore = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );

      await asTenant(() => waves().abandonWave(scene.orgId, scene.userId, pickListId));
      // Abandoning gives up the walk, not the goods already in the tote —
      // unwinding those is what an exception is for, and a second unwind here
      // would be a silent stock movement.
      const pickedAfter = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      expect(pickedAfter.lines[0]!.quantity_picked).toBe(
        pickedBefore.lines[0]!.quantity_picked,
      );
      expect(pickedAfter.assignedTo).toBeNull();

      const reassigned = await asTenant(() =>
        waves().reassignWave(scene.orgId, scene.userId, pickListId, {
          assigneeUserId: scene.reliefUserId,
        }),
      );
      expect(reassigned.assignedTo).toBe(scene.reliefUserId);

      const finished = await asTenant(() =>
        waves().getWave(scene.orgId, scene.reliefUserId, pickListId),
      );
      expect(finished.assignedTo).toBe(scene.reliefUserId);
    });

    it("refuses to reassign to somebody outside the organisation", async () => {
      const { pickListId } = await unclaimedWave();
      await expect(
        asTenant(() =>
          waves().reassignWave(scene.orgId, scene.userId, pickListId, {
            assigneeUserId: randomUUID(),
          }),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /** B4, item 5 — the queue the workbench reads. */
  describe("the wave queue", () => {
    it("separates the waves waiting from the ones this picker holds", async () => {
      const soId = await confirmedOrder(1);
      const wave = await asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [soId],
        }),
      );

      const unclaimed = await asTenant(() =>
        waves().listWaves(scene.orgId, scene.userId, {
          page: 1,
          limit: 100,
          assignment: "UNCLAIMED",
        }),
      );
      expect(unclaimed.items.some((w) => w.id === wave.pickListId)).toBe(true);

      await asTenant(() => waves().claimWave(scene.orgId, scene.userId, wave.pickListId));

      const mine = await asTenant(() =>
        waves().listWaves(scene.orgId, scene.userId, {
          page: 1,
          limit: 100,
          assignment: "MINE",
        }),
      );
      const row = mine.items.find((w) => w.id === wave.pickListId);
      expect(row).toBeDefined();
      expect(row!.assignedTo).toBe(scene.userId);
      expect(row!.orderCount).toBe(1);
      expect(row!.lineCount).toBe(1);
      expect(row!.linesClosed).toBe(0);

      const stillUnclaimed = await asTenant(() =>
        waves().listWaves(scene.orgId, scene.userId, {
          page: 1,
          limit: 100,
          assignment: "UNCLAIMED",
        }),
      );
      expect(stillUnclaimed.items.some((w) => w.id === wave.pickListId)).toBe(false);
    });

    it("does not list single-order picks as waves", async () => {
      // `soId` is what separates the two, and the workbench is a wave board.
      const listed = await asTenant(() =>
        waves().listWaves(scene.orgId, scene.userId, { page: 1, limit: 100, assignment: "ANY" }),
      );
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ count: number }>(sql`
          SELECT COUNT(*)::int AS count FROM inv_pick_lists
           WHERE org_id = ${scene.orgId} AND so_id IS NOT NULL`),
      );
      expect(listed.items.every((w) => w.pickNumber.length > 0)).toBe(true);
      expect(listed.total + Number(row!.count)).toBeGreaterThanOrEqual(listed.total);
    });
  });

  /** B4, item 4 — the scan has to agree on all three axes, not only the SKU. */
  describe("scan validation", () => {
    it("refuses a scan whose lot is not the one allocated to the line", async () => {
      const suffix = randomUUID().slice(0, 6);
      const [lot] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status)
          VALUES (${scene.orgId}, ${scene.variantId}, ${`LOT-${suffix}`}, 'ACTIVE')
          RETURNING id`),
      );
      const soId = await confirmedOrder(1);
      const wave = await asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.warehouseId,
          soIds: [soId],
        }),
      );
      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, wave.pickListId),
      );
      const lineId = detail.lines[0]!.id;
      // The line was allocated to a lot-free row; pin it to a different lot so
      // the scan below disagrees with it.
      await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute(sql`
          UPDATE inv_pick_list_lines SET lot_id = ${lot!.id}
           WHERE org_id = ${scene.orgId} AND id = ${lineId}`),
      );

      const [otherLot] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ lot_number: string }>(sql`
          INSERT INTO inv_lots (org_id, product_variant_id, lot_number, status)
          VALUES (${scene.orgId}, ${scene.variantId}, ${`LOT-${suffix}-B`}, 'ACTIVE')
          RETURNING lot_number`),
      );

      // Right product, wrong batch — which for a lot-tracked line is the whole
      // reason lots exist, and the SKU check alone waves it through.
      await expect(
        asTenant(() =>
          picks().confirmPick(scene.orgId, scene.userId, wave.pickListId, {
            pickLineId: lineId,
            quantityPicked: "1.0000",
            scannedPayload: otherLot!.lot_number,
          }, `wave-lot-mismatch-${wave.pickListId}`),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
