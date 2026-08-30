import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { availableQtySumSql } from "src/modules/inventory/stock-engine/available-sql";
import { ChannelPoolService } from "src/modules/inventory/stock-engine/channel-pool.service";
import { QuickCommerceInboundService } from "src/modules/inventory/channels/quick-commerce/quick-commerce-inbound.service";
import { FillRateService } from "src/modules/inventory/channels/quick-commerce/fill-rate.service";
import { DockService } from "src/modules/inventory/dock/dock.service";
import { HandlingUnitService } from "src/modules/inventory/handling-units/handling-unit.service";
import { KitService } from "src/modules/inventory/kitting/kit.service";
import { OwnershipService } from "src/modules/inventory/stock-types/ownership.service";
import { SlottingService } from "src/modules/inventory/slotting/slotting.service";
import { PickWaveService } from "src/modules/inventory/picking/pick-wave.service";
import { PickConfirmService } from "src/modules/inventory/picking/pick-confirm.service";
import { InventorySettingsService } from "src/modules/inventory/stock-engine/inventory-settings.service";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { PutawayService } from "src/modules/inventory/warehouses/putaway.service";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { SoFulfillmentService } from "src/modules/inventory/sales-orders/so-fulfillment.service";
import { InvReconciliationService } from "src/modules/inventory/reconciliation/inv-reconciliation.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * NEO-16 - the whole of the NEO programme, once, in the order a warehouse works
 * in.
 *
 * `golden-path.seeded-e2e-spec.ts` walks the original module end to end and
 * still does; this walks what NEO added, for the same reason that one exists.
 * Fourteen units were built here and each has its own green suite, and a chain
 * can be broken at a seam while every link passes: the earlier programme found
 * `packSo` and `shipSo` both looking up pick lists by a column that is null for
 * a wave, with green unit suites on both.
 *
 * **Every assertion names its unit.** A failure here has to point at the unit
 * that owns it, or somebody reads a red suite and cannot tell whether the pool,
 * the handling unit or the pick broke.
 *
 * The observables are business ones: what may be promised, where stock is
 * standing, and whether the ledger still explains the projection after every
 * step. A step that silently does nothing shows up as stock that did not move.
 *
 *   pnpm test:e2e:seeded --testPathPattern=neo-golden-path
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:warehouses:read",
  "inventory:warehouses:manage",
  "inventory:stock:read",
  "inventory:stock:reserve",
  "inventory:stock:adjust",
  "inventory:stock:transfer",
  "inventory:products:read",
  "inventory:products:update",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:approve",
  "inventory:purchase-orders:receive",
  "inventory:sales-orders:create",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
  "inventory:channels:manage",
  "inventory:kits:assemble",
  "inventory:dock:manage",
  "inventory:reports:read",
] as const;

/** Shared with the original golden path: a busy database makes 120s a coin toss. */
const SLICE_TIMEOUT_MS = 300_000;

interface Scene {
  orgId: string;
  userId: string;
  tag: string;
  warehouseId: number;
  receivingId: number;
  goldBinId: number;
  backBinId: number;
  zoneId: number;
  shippingId: number;
  vendorId: number;
  /** The SKU the platform orders and we ship. */
  variantId: number;
  sku: string;
  ean: string;
  /** Sold as a kit built from the two below. */
  kitVariantId: number;
  componentAId: number;
  componentBId: number;
  /** NEO-8: never stocked. It arrives and leaves on the same shift. */
  crossDockVariantId: number;
  /** NEO-10: sold by weight, handled in bags. */
  catchWeightVariantId: number;
  /** NEO-14: enough of it that four orders can all be picked. */
  wavelessVariantId: number;
  channelId: number;
}

describe("[seeded-e2e] NEO-16 the world-class path", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  let platformPoId: number;
  let poId: number;
  let poLineId: number;
  let asnId: number;
  let handlingUnitId: number;
  let grnId: number;
  let crossDockSoId: number;
  let crossDockPoId: number;
  let crossDockPoLineId: number;
  let catchWeightPoId: number;
  let catchWeightPoLineId: number;
  let catchWeightSoId: number;
  let waveId: number;
  let wavelessSoB: number;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const db = () => app.app.get<Db>(DRIZZLE);

  /** Through the canonical expression, never a copy of it. */
  const atp = async (variantId: number): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ available: string }>(sql`
        SELECT ${availableQtySumSql("sl")}::text AS available
        FROM inv_stock_levels sl
        WHERE sl.org_id = ${scene.orgId} AND sl.product_variant_id = ${variantId}`),
    );
    return Number(row!.available);
  };

  const onHandAt = async (variantId: number, locationId: number): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ qty: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS qty FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}
          AND location_id = ${locationId}`),
    );
    return Number(row!.qty);
  };

  const onHandOnUnit = async (variantId: number, huId: number): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ qty: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS qty FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}
          AND handling_unit_id = ${huId}`),
    );
    return Number(row!.qty);
  };

  /** Every level row for a variant, so "nowhere else" can be asserted rather than sampled. */
  const levelsFor = async (
    variantId: number,
  ): Promise<Array<{ locationId: number; onHand: number; committed: number }>> => {
    const rows = await asTenant(() =>
      db().execute<{ location_id: number; on_hand: string; committed: string }>(sql`
        SELECT location_id, on_hand::text, committed::text FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}
        ORDER BY location_id`),
    );
    return rows.map((r) => ({
      locationId: Number(r.location_id),
      onHand: Number(r.on_hand),
      committed: Number(r.committed),
    }));
  };

  /**
   * NEO-10 - on hand as the database holds it, not as a float rounds it.
   *
   * `onHandAt` returns a `number` and that is right for counting bags. A weight
   * is the one quantity this repository forbids float arithmetic on, so the
   * catch-weight slice compares the decimal string itself: 5.2500 is either the
   * remainder or it is not, and `toBeCloseTo` would let 5.249999 pass.
   */
  const onHandTextAt = async (variantId: number, locationId: number): Promise<string> => {
    const [row] = await asTenant(() =>
      db().execute<{ qty: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::numeric(18,4)::text AS qty FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}
          AND location_id = ${locationId}`),
    );
    return row!.qty;
  };

  /** NEO-8: what is actually being held for an order, and where. */
  const reservationsFor = async (
    soId: number,
  ): Promise<Array<{ locationId: number; reservedQty: number; status: string }>> => {
    const rows = await asTenant(() =>
      db().execute<{ location_id: number | null; reserved_qty: string; status: string }>(sql`
        SELECT location_id, reserved_qty::text, status FROM inv_stock_reservations
        WHERE org_id = ${scene.orgId}
          AND source_type = 'inv_sales_order' AND source_id = ${String(soId)}
          AND status = 'ACTIVE'
        ORDER BY id`),
    );
    return rows.map((r) => ({
      locationId: Number(r.location_id),
      reservedQty: Number(r.reserved_qty),
      status: r.status,
    }));
  };

  /** The invariant after every step: the ledger explains the projection. */
  const expectReconciled = async (step: string): Promise<void> => {
    const report = await asTenant(() =>
      app.app.get(InvReconciliationService).report(scene.orgId, scene.userId, { limit: 50 }),
    );
    expect({ step, drift: report.drift }).toEqual({ step, drift: [] });
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: [...PERMISSIONS] })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    scene = await runInNewTenantTransaction(db(), seeded.orgId, async () => {
      const userId = seeded.members.keeper!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);

      const makeVariant = async (
        name: string,
        code: string,
        /** NEO-10: weight in the ledger, pieces on the document. */
        measureMode: "PIECES" | "CATCH_WEIGHT" = "PIECES",
      ) => {
        const product = await one<{ id: number }>(sql`
          INSERT INTO inv_products (org_id, uom_id, name, sku, measure_mode, created_by)
          VALUES (${seeded.orgId}, ${uom.id}, ${name}, ${`${code}-${tag}`}, ${measureMode}, ${userId})
          RETURNING id`);
        const variant = await one<{ id: number }>(sql`
          INSERT INTO inv_product_variants (org_id, product_id, name, sku)
          VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`${code}-${tag}-V`}) RETURNING id`);
        return variant.id;
      };

      const variantId = await makeVariant("NEO widget", "NEO");
      const kitVariantId = await makeVariant("NEO gift set", "NEOKIT");
      const componentAId = await makeVariant("NEO component A", "NEOCA");
      const componentBId = await makeVariant("NEO component B", "NEOCB");
      const crossDockVariantId = await makeVariant("NEO cross-dock case", "NEOXD");
      const catchWeightVariantId = await makeVariant("NEO chicken", "NEOCW", "CATCH_WEIGHT");
      const wavelessVariantId = await makeVariant("NEO wave item", "NEOWV");

      // NEO-2 matches a platform line on the barcode both sides agreed on.
      const ean = `890${tag.replace(/\D/g, "0").padEnd(10, "0").slice(0, 10)}`;
      await db().execute(sql`
        INSERT INTO inv_barcodes (org_id, product_variant_id, code, barcode_type, is_primary)
        VALUES (${seeded.orgId}, ${variantId}, ${ean}, 'GTIN', true)`);

      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'NEO', ${`NW${tag}`}, ${userId}) RETURNING id`);
      const receiving = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Dock', ${`ND${tag}`}, 'RECEIVING', true, false)
        RETURNING id`);
      // NEO-6: a gold zone with one bin under it, and a back bin outside it.
      const zone = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Gold zone', ${`NZ${tag}`}, 'ZONE', false, false)
        RETURNING id`);
      const goldBin = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, parent_location_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, ${zone.id}, 'Gold bin', ${`NG${tag}`}, 'BIN', true, true)
        RETURNING id`);
      const backBin = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Back bin', ${`NB${tag}`}, 'BIN', true, true)
        RETURNING id`);
      const shipping = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable, is_pickable)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Staging', ${`NS${tag}`}, 'SHIPPING', true, true)
        RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'NEO vendor', ${`NV${tag}`}, ${userId}) RETURNING id`);

      // NEO-1/NEO-2: the platform, as a channel.
      const channel = await one<{ id: number }>(sql`
        INSERT INTO inv_channels (org_id, name, channel_type, status, qc_provider)
        VALUES (${seeded.orgId}, ${`Blinkit ${tag}`}, 'MARKETPLACE', 'ACTIVE', 'BLINKIT')
        RETURNING id`);

      // NEO-2's pack, and NEO-2's flag. Both off by default; this organisation
      // has asked for them.
      await db().execute(sql`
        INSERT INTO inv_settings (org_id, pack_quick_commerce)
        VALUES (${seeded.orgId}, true)
        ON CONFLICT (org_id) DO UPDATE SET pack_quick_commerce = true`);

      return {
        orgId: seeded.orgId,
        userId,
        tag,
        warehouseId: warehouse.id,
        receivingId: receiving.id,
        goldBinId: goldBin.id,
        backBinId: backBin.id,
        zoneId: zone.id,
        shippingId: shipping.id,
        vendorId: vendor.id,
        variantId,
        sku: `NEO-${tag}-V`,
        ean,
        kitVariantId,
        componentAId,
        componentBId,
        crossDockVariantId,
        catchWeightVariantId,
        wavelessVariantId,
        channelId: channel.id,
      };
    });
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app?.close();
  }, 120_000);

  it("NEO-0: starts with nothing on the shelf and nothing promisable", async () => {
    expect(await atp(scene.variantId)).toBe(0);
    await expectReconciled("NEO-0 empty");
  }, SLICE_TIMEOUT_MS);

  it("NEO-2: ingests a Blinkit purchase order and matches every line to the catalogue", async () => {
    const result = await asTenant(() =>
      app.app.get(QuickCommerceInboundService).ingestPurchaseOrder(
        scene.orgId,
        scene.userId,
        {
          provider: "BLINKIT",
          warehouseId: scene.warehouseId,
          payload: {
            po_number: `BLK-${scene.tag}`,
            facility_code: "BLR-DARK-07",
            expected_delivery_date: "2026-09-01",
            line_items: [
              { item_code: "BLK-1", ean: scene.ean, mrp: "125.50", pack_size: 12, quantity: 100, landing_rate: "4.0000" },
            ],
          },
        },
        `neo-ingest-${scene.tag}`,
      ),
    );

    platformPoId = result.id;
    expect(result.status).toBe("RECEIVED");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.validationError).toBeNull();
    expect(result.lines[0]!.productVariantId).toBe(scene.variantId);
  }, SLICE_TIMEOUT_MS);

  it("NEO-2: is idempotent on the platform's own purchase-order number", async () => {
    // A retried delivery, a re-uploaded file and a re-parsed email must land on
    // one row rather than making three purchase orders.
    const again = await asTenant(() =>
      app.app.get(QuickCommerceInboundService).ingestPurchaseOrder(
        scene.orgId,
        scene.userId,
        {
          provider: "BLINKIT",
          warehouseId: scene.warehouseId,
          payload: {
            po_number: `BLK-${scene.tag}`,
            line_items: [{ ean: scene.ean, quantity: 100 }],
          },
        },
        `neo-ingest-again-${scene.tag}`,
      ),
    );
    expect(again.id).toBe(platformPoId);
  }, SLICE_TIMEOUT_MS);

  it("NEO-2/NEO-1: accepting raises a purchase order and claims the stock for the channel", async () => {
    const accepted = await asTenant(() =>
      app.app.get(QuickCommerceInboundService).acceptPurchaseOrder(
        scene.orgId,
        scene.userId,
        platformPoId,
        {
          vendorId: scene.vendorId,
          warehouseId: scene.warehouseId,
          orderDate: "2026-08-01",
          reserveIntoChannelPool: false,
        },
        `neo-accept-${scene.tag}`,
      ),
    );
    expect(accepted.poId).not.toBeNull();
    poId = accepted.poId!;

    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, poId, scene.userId));
    const [line] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${poId}`),
    );
    poLineId = line!.id;
  }, SLICE_TIMEOUT_MS);

  it("NEO-2/NEO-12: announces the shipment and books it a dock slot", async () => {
    const asn = await asTenant(() =>
      app.app.get(QuickCommerceInboundService).createAsn(
        scene.orgId,
        scene.userId,
        {
          poId,
          platformPoId,
          warehouseId: scene.warehouseId,
          expectedArrival: "2026-09-01",
          lines: [
            { poLineId, productVariantId: scene.variantId, quantityExpected: "100.0000" },
          ],
        },
        `neo-asn-${scene.tag}`,
      ),
    );
    asnId = asn.id;

    const door = await asTenant(() =>
      app.app.get(DockService).createDoor(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        code: `D1-${scene.tag}`,
        direction: "INBOUND",
      }),
    );

    const booked = await asTenant(() =>
      app.app.get(DockService).book(scene.orgId, scene.userId, {
        doorId: door!.id,
        direction: "INBOUND",
        windowStart: "2026-09-01T09:00:00.000Z",
        windowEnd: "2026-09-01T10:00:00.000Z",
        asnId,
        carrierName: "NEO Carriers",
      }),
    );
    expect(booked!.status).toBe("BOOKED");

    // The rule the calendar exists for: two vehicles cannot hold one door.
    await expect(
      asTenant(() =>
        app.app.get(DockService).book(scene.orgId, scene.userId, {
          doorId: door!.id,
          direction: "INBOUND",
          windowStart: "2026-09-01T09:30:00.000Z",
          windowEnd: "2026-09-01T10:30:00.000Z",
        }),
      ),
    ).rejects.toThrow(/already booked/i);
  }, SLICE_TIMEOUT_MS);

  it("NEO-4: receives the delivery onto a pallet, not loose onto the dock", async () => {
    const unit = await asTenant(() =>
      app.app.get(HandlingUnitService).create(
        scene.orgId,
        scene.userId,
        { kind: "PALLET", locationId: scene.receivingId },
        `neo-hu-${scene.tag}`,
      ),
    );
    handlingUnitId = unit.id;

    const grn = await asTenant(() =>
      app.app.get(GrnService).receiveGoods(scene.orgId, poId, scene.userId, `neo-receive-${scene.tag}`, {
        receivedDate: "2026-09-01",
        locationId: scene.receivingId,
        asnId,
        lines: [
          {
            poLineId,
            quantityReceived: "100.0000",
            qualityStatus: "ACCEPTED",
            handlingUnitId,
          },
        ],
      }),
    );
    grnId = (grn as { id: number }).id;

    expect(await onHandOnUnit(scene.variantId, handlingUnitId)).toBe(100);
    expect(await onHandAt(scene.variantId, scene.receivingId)).toBe(100);
    expect(await atp(scene.variantId)).toBe(100);
    await expectReconciled("NEO-4 received into a handling unit");
  }, SLICE_TIMEOUT_MS);

  it("NEO-6: puts the gold-zone bin first once a slotting rule says so", async () => {
    const before = await asTenant(() =>
      app.app.get(PutawayService).suggest(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        productVariantId: scene.variantId,
        quantity: "100.0000",
      }),
    );
    expect(before.every((s) => !s.inSlot)).toBe(true);

    await asTenant(() =>
      app.app.get(SlottingService).createRule(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        name: `Gold ${scene.tag}`,
        matchType: "PRODUCT_VARIANT",
        productVariantId: scene.variantId,
        targetZoneLocationId: scene.zoneId,
        priority: 10,
      }),
    );

    const after = await asTenant(() =>
      app.app.get(PutawayService).suggest(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        productVariantId: scene.variantId,
        quantity: "100.0000",
      }),
    );
    expect(after[0]!.locationId).toBe(scene.goldBinId);
    expect(after[0]!.inSlot).toBe(true);
  }, SLICE_TIMEOUT_MS);

  it("NEO-4: moves the whole pallet to the gold bin in one command", async () => {
    await asTenant(() =>
      app.app.get(HandlingUnitService).move(
        scene.orgId,
        scene.userId,
        handlingUnitId,
        { toLocationId: scene.goldBinId },
        `neo-hu-move-${scene.tag}`,
      ),
    );

    expect(await onHandAt(scene.variantId, scene.receivingId)).toBe(0);
    expect(await onHandAt(scene.variantId, scene.goldBinId)).toBe(100);
    expect(await onHandOnUnit(scene.variantId, handlingUnitId)).toBe(100);
    expect(await atp(scene.variantId)).toBe(100);
    await expectReconciled("NEO-4 pallet moved");
  }, SLICE_TIMEOUT_MS);

  it("NEO-1: a channel claim withholds stock from a direct sale", async () => {
    await asTenant(() =>
      app.app.get(ChannelPoolService).allocate(scene.orgId, scene.userId, {
        channelId: scene.channelId,
        productVariantId: scene.variantId,
        warehouseId: scene.warehouseId,
        deltaQty: "60.0000",
        idempotencyKey: `neo-pool-${scene.tag}`,
      }),
    );

    const direct = await asTenant(() =>
      app.app.get(ChannelPoolService).availabilityFor(scene.orgId, {
        productVariantId: scene.variantId,
        warehouseId: scene.warehouseId,
      }),
    );
    expect(Number(direct.available)).toBe(100);
    expect(Number(direct.reservedByOthers)).toBe(60);
    expect(Number(direct.netAvailable)).toBe(40);

    const forChannel = await asTenant(() =>
      app.app.get(ChannelPoolService).availabilityFor(scene.orgId, {
        productVariantId: scene.variantId,
        warehouseId: scene.warehouseId,
        forChannelId: scene.channelId,
      }),
    );
    // The channel sees its own claim as its own, not as somebody else's.
    expect(Number(forChannel.netAvailable)).toBe(100);
  }, SLICE_TIMEOUT_MS);

  it("NEO-1: the channel's own order ships, and draws its claim down", async () => {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-09-02",
        warehouseId: scene.warehouseId,
        channelId: scene.channelId,
        platformPoId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: 60,
            unitPrice: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    const soId = (so as { id: number }).id;

    await asTenant(() =>
      app.app.get(SoLifecycleService).confirmSo(scene.orgId, soId, scene.userId, `neo-confirm-${scene.tag}`),
    );
    await asTenant(() =>
      app.app.get(SoFulfillmentService).shipSo(scene.orgId, soId, scene.userId, `neo-ship-${scene.tag}`, {
        shipDate: "2026-09-03",
      }),
    );

    expect(await onHandAt(scene.variantId, scene.goldBinId)).toBe(40);

    const after = await asTenant(() =>
      app.app.get(ChannelPoolService).availabilityFor(scene.orgId, {
        productVariantId: scene.variantId,
        warehouseId: scene.warehouseId,
      }),
    );
    // The claim existed to stop anybody else selling those units; once they have
    // gone there is nothing left to hold.
    expect(Number(after.reservedByOthers)).toBe(0);
    expect(Number(after.netAvailable)).toBe(40);
    await expectReconciled("NEO-1 channel order shipped");

    const fillRate = await asTenant(() =>
      app.app.get(FillRateService).report(scene.orgId, scene.userId, { platformPoId }),
    );
    // NEO-3: 100 ordered, 60 shipped.
    expect(Number(fillRate.orderedQty)).toBe(100);
    expect(Number(fillRate.acceptedQty)).toBe(60);
    expect(Number(fillRate.fillRatePct)).toBeCloseTo(60, 2);
  }, SLICE_TIMEOUT_MS);

  it("NEO-9: assembles a kit, consuming its components and costing it from them", async () => {
    // Seeded through the engine, not by inserting a level row. A hand-written
    // projection is drift the moment `expectReconciled` looks at it, and the
    // check would be right: the ledger would not explain it. Going through the
    // engine also writes the valuation layers the kit is later costed from.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `neo-components-${scene.tag}`,
        sourceType: "inv_opening_balance",
        sourceId: `neo-${scene.tag}`,
        reason: "Opening components for the kit",
        movements: [scene.componentAId, scene.componentBId].map((componentId) => ({
          transactionType: "OPENING_BALANCE",
          productVariantId: componentId,
          locationId: scene.backBinId,
          quantityDelta: "10.0000",
          unitCost: "5.0000",
        })),
      }),
    );

    await asTenant(() =>
      app.app.get(KitService).setBom(scene.orgId, scene.userId, scene.kitVariantId, {
        components: [
          { componentVariantId: scene.componentAId, quantityPer: "2.0000" },
          { componentVariantId: scene.componentBId, quantityPer: "1.0000" },
        ],
      }),
    );

    const buildable = await asTenant(() =>
      app.app.get(KitService).buildable(scene.orgId, scene.kitVariantId, scene.warehouseId),
    );
    expect(Number(buildable)).toBe(5);

    // Short by construction: five is all the components allow.
    await expect(
      asTenant(() =>
        app.app.get(KitService).assemble(
          scene.orgId,
          scene.userId,
          { kitVariantId: scene.kitVariantId, locationId: scene.backBinId, quantity: "6.0000" },
          `neo-kit-short-${scene.tag}`,
        ),
      ),
    ).rejects.toThrow();

    const built = await asTenant(() =>
      app.app.get(KitService).assemble(
        scene.orgId,
        scene.userId,
        { kitVariantId: scene.kitVariantId, locationId: scene.backBinId, quantity: "3.0000" },
        `neo-kit-${scene.tag}`,
      ),
    );

    expect(await atp(scene.kitVariantId)).toBe(3);
    expect(await onHandAt(scene.componentAId, scene.backBinId)).toBe(4);
    expect(await onHandAt(scene.componentBId, scene.backBinId)).toBe(7);
    // Three kits of (2 x 5) + (1 x 5) = 45.
    expect(Number(built.totalCost)).toBeCloseTo(45, 4);
    await expectReconciled("NEO-9 kit assembled");
  }, SLICE_TIMEOUT_MS);

  /**
   * NEO-8 — the cross-dock, walked rather than described.
   *
   * The structural spec pins leg ordering and the staging refusal. What it
   * cannot say is whether a delivery that never touches a storage bin can be
   * shipped: the reservation the receipt raises has to be one the *ship* command
   * recognises, and those are two modules that agreed on a shape in prose.
   *
   * Read as one story: an order we cannot fill, a delivery for it, and the units
   * leaving again without ever being sellable to anybody else.
   */
  it("NEO-8: an order for stock we do not have is confirmed short, reserving nothing", async () => {
    expect(await atp(scene.crossDockVariantId)).toBe(0);

    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-09-04",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.crossDockVariantId,
            quantity: 25,
            unitPrice: "12.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    crossDockSoId = (so as { id: number }).id;

    await asTenant(() =>
      app.app
        .get(SoLifecycleService)
        .confirmSo(scene.orgId, crossDockSoId, scene.userId, `neo-xd-confirm-${scene.tag}`),
    );

    const [row] = await asTenant(() =>
      db().execute<{ status: string }>(sql`
        SELECT status FROM inv_sales_orders
        WHERE org_id = ${scene.orgId} AND id = ${crossDockSoId}`),
    );
    // Short, and honest about it: there is nothing on the shelf to hold.
    expect(row!.status).toBe("PARTIALLY_RESERVED");
    expect(await reservationsFor(crossDockSoId)).toEqual([]);
  }, SLICE_TIMEOUT_MS);

  it("NEO-8: receives that delivery straight to outbound staging, reaching no storage bin", async () => {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-09-04",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.crossDockVariantId,
            quantity: 25,
            unitCost: "6.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    crossDockPoId = (po as { id: number }).id;
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, crossDockPoId, scene.userId));

    const [line] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${crossDockPoId}`),
    );
    crossDockPoLineId = line!.id;

    await asTenant(() =>
      app.app
        .get(GrnService)
        .receiveGoods(scene.orgId, crossDockPoId, scene.userId, `neo-xd-receive-${scene.tag}`, {
          receivedDate: "2026-09-04",
          locationId: scene.receivingId,
          lines: [
            {
              poLineId: crossDockPoLineId,
              quantityReceived: "25.0000",
              qualityStatus: "ACCEPTED",
              crossDockSoId,
            },
          ],
        }),
    );

    // The unit's whole claim: the goods are at staging and nowhere else. Read as
    // every level row rather than three sampled bins, so a fourth location
    // holding stock is a failure rather than a place nobody looked.
    const levels = await levelsFor(scene.crossDockVariantId);
    expect(levels.filter((l) => l.onHand !== 0).map((l) => [l.locationId, l.onHand])).toEqual([
      [scene.shippingId, 25],
    ]);
    expect(await onHandAt(scene.crossDockVariantId, scene.receivingId)).toBe(0);
    expect(await onHandAt(scene.crossDockVariantId, scene.goldBinId)).toBe(0);
    expect(await onHandAt(scene.crossDockVariantId, scene.backBinId)).toBe(0);

    // NEO-8: and they were never anybody else's to sell. Twenty-five stand at a
    // pickable location, and every one is spoken for.
    expect(await atp(scene.crossDockVariantId)).toBe(0);

    const held = await reservationsFor(crossDockSoId);
    expect(held).toEqual([
      { locationId: scene.shippingId, reservedQty: 25, status: "ACTIVE" },
    ]);

    await expectReconciled("NEO-8 cross-docked to staging");
  }, SLICE_TIMEOUT_MS);

  it("NEO-8: does not post the delivery twice when the receipt is retried", async () => {
    // The lorry driver's tablet lost signal and sent the same receipt again.
    await asTenant(() =>
      app.app
        .get(GrnService)
        .receiveGoods(scene.orgId, crossDockPoId, scene.userId, `neo-xd-receive-${scene.tag}`, {
          receivedDate: "2026-09-04",
          locationId: scene.receivingId,
          lines: [
            {
              poLineId: crossDockPoLineId,
              quantityReceived: "25.0000",
              qualityStatus: "ACCEPTED",
              crossDockSoId,
            },
          ],
        }),
    ).catch(() => undefined);

    expect(await onHandAt(scene.crossDockVariantId, scene.shippingId)).toBe(25);
    expect(await reservationsFor(crossDockSoId)).toEqual([
      { locationId: scene.shippingId, reservedQty: 25, status: "ACTIVE" },
    ]);
    await expectReconciled("NEO-8 receipt retried");
  }, SLICE_TIMEOUT_MS);

  it("NEO-8: ships the cross-docked order off the reservation the receipt raised", async () => {
    await asTenant(() =>
      app.app
        .get(SoFulfillmentService)
        .shipSo(scene.orgId, crossDockSoId, scene.userId, `neo-xd-ship-${scene.tag}`, {
          shipDate: "2026-09-04",
        }),
    );

    expect(await onHandAt(scene.crossDockVariantId, scene.shippingId)).toBe(0);
    expect(await atp(scene.crossDockVariantId)).toBe(0);
    expect(
      (await levelsFor(scene.crossDockVariantId)).filter((l) => l.onHand !== 0),
    ).toEqual([]);
    await expectReconciled("NEO-8 cross-dock shipped");
  }, SLICE_TIMEOUT_MS);

  /**
   * NEO-10 — catch-weight, received and sold.
   *
   * The rules had unit coverage and no SKU had ever been through them. What a
   * walk adds is the arithmetic across two movements: 10.35 kg in, 5.10 kg out,
   * 5.25 kg left, and an invoice raised on the weight rather than on the two
   * bags it arrived in. Every figure here is compared as a decimal string —
   * a weight is the one quantity this repository forbids floats on, and
   * `toBeCloseTo` would let 5.249999 through.
   */
  it("NEO-10: refuses a catch-weight receipt that does not say how many bags", async () => {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-09-05",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.catchWeightVariantId,
            quantity: 10.35,
            unitCost: "200.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    catchWeightPoId = (po as { id: number }).id;
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, catchWeightPoId, scene.userId));

    const [line] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${catchWeightPoId}`),
    );
    catchWeightPoLineId = line!.id;

    // A weight with no piece count cannot be picked: nobody knows how many bags
    // to take off the shelf.
    await expect(
      asTenant(() =>
        app.app
          .get(GrnService)
          .receiveGoods(scene.orgId, catchWeightPoId, scene.userId, `neo-cw-bad-${scene.tag}`, {
            receivedDate: "2026-09-05",
            locationId: scene.receivingId,
            lines: [
              {
                poLineId: catchWeightPoLineId,
                quantityReceived: "10.3500",
                qualityStatus: "ACCEPTED",
              },
            ],
          }),
      ),
    ).rejects.toThrow(/pieces/i);
  }, SLICE_TIMEOUT_MS);

  it("NEO-10: receives two bags weighing 10.35 kg, and the ledger holds the weight", async () => {
    await asTenant(() =>
      app.app
        .get(GrnService)
        .receiveGoods(scene.orgId, catchWeightPoId, scene.userId, `neo-cw-receive-${scene.tag}`, {
          receivedDate: "2026-09-05",
          locationId: scene.receivingId,
          lines: [
            {
              poLineId: catchWeightPoLineId,
              quantityReceived: "10.3500",
              quantityPieces: "2.0000",
              qualityStatus: "ACCEPTED",
            },
          ],
        }),
    );

    // The ledger holds the weight, exactly.
    expect(await onHandTextAt(scene.catchWeightVariantId, scene.receivingId)).toBe("10.3500");

    // The bags ride alongside on the document, for the person counting them.
    const [grnLine] = await asTenant(() =>
      db().execute<{ quantity_received: string; quantity_pieces: string | null }>(sql`
        SELECT gl.quantity_received::text, gl.quantity_pieces::text
          FROM inv_grn_lines gl
          JOIN inv_grns g ON g.org_id = gl.org_id AND g.id = gl.grn_id
         WHERE gl.org_id = ${scene.orgId} AND g.po_id = ${catchWeightPoId}`),
    );
    expect(grnLine!.quantity_received).toBe("10.3500");
    expect(grnLine!.quantity_pieces).toBe("2.0000");

    await expectReconciled("NEO-10 catch-weight received");
  }, SLICE_TIMEOUT_MS);

  it("NEO-10: prices the sale from the weight and not from the number of bags", async () => {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-09-06",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.catchWeightVariantId,
            // One bag, and the bag weighed 5.10 kg. Both facts, because neither
            // derives from the other.
            quantity: 5.1,
            quantityPieces: 1,
            unitPrice: "250.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    catchWeightSoId = (so as { id: number }).id;

    const [soLine] = await asTenant(() =>
      db().execute<{ quantity: string; quantity_pieces: string | null; amount: string }>(sql`
        SELECT quantity::text, quantity_pieces::text, amount::text FROM inv_so_lines
        WHERE org_id = ${scene.orgId} AND so_id = ${catchWeightSoId}`),
    );

    expect(soLine!.quantity).toBe("5.1000");
    // The whole point of catch-weight: 250 a kilo times 5.10 kg is 1275, and it
    // is emphatically not 250 for the one bag.
    expect(soLine!.amount).toBe("1275.0000");
    expect(soLine!.amount).not.toBe("250.0000");
    // And the picker is told how many bags to take.
    expect(soLine!.quantity_pieces).toBe("1.0000");

    const [header] = await asTenant(() =>
      db().execute<{ subtotal: string; total: string }>(sql`
        SELECT subtotal::text, total::text FROM inv_sales_orders
        WHERE org_id = ${scene.orgId} AND id = ${catchWeightSoId}`),
    );
    expect(header!.subtotal).toBe("1275.0000");
  }, SLICE_TIMEOUT_MS);

  it("NEO-10: ships one bag and leaves 5.25 kg on the shelf", async () => {
    await asTenant(() =>
      app.app
        .get(SoLifecycleService)
        .confirmSo(scene.orgId, catchWeightSoId, scene.userId, `neo-cw-confirm-${scene.tag}`),
    );
    await asTenant(() =>
      app.app
        .get(SoFulfillmentService)
        .shipSo(scene.orgId, catchWeightSoId, scene.userId, `neo-cw-ship-${scene.tag}`, {
          shipDate: "2026-09-06",
        }),
    );

    // 10.3500 - 5.1000. Compared as the string the database holds, so a float
    // remainder cannot round itself right.
    expect(await onHandTextAt(scene.catchWeightVariantId, scene.receivingId)).toBe("5.2500");
    await expectReconciled("NEO-10 catch-weight shipped");
  }, SLICE_TIMEOUT_MS);

  /**
   * NEO-14 — waveless picking, with a wave actually joined.
   *
   * The decision was a pure function with a spec per condition, and
   * `proposeWaveJoin` returned it over HTTP. Its own comment said the caller
   * "then either posts to the join route or raises a new wave" and there was no
   * join route, so the answer had nothing to act on and no order had ever
   * attached to an open wave.
   *
   * Both branches are here because "off" is the more important one: off has to
   * mean the code path is not reached, not reached and ignored.
   */
  const confirmedOrderFor = async (qty: number, key: string): Promise<number> => {
    const so = await asTenant(() =>
      app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
        orderDate: "2026-09-07",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: scene.wavelessVariantId,
            quantity: qty,
            unitPrice: "3.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    const soId = (so as { id: number }).id;
    await asTenant(() =>
      app.app.get(SoLifecycleService).confirmSo(scene.orgId, soId, scene.userId, key),
    );
    return soId;
  };

  const activeReservationCount = async (soId: number): Promise<number> => {
    const [row] = await asTenant(() =>
      db().execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM inv_stock_reservations
        WHERE org_id = ${scene.orgId} AND source_type = 'inv_sales_order'
          AND source_id = ${String(soId)} AND status = 'ACTIVE'`),
    );
    return Number(row!.n);
  };

  const waveOfSo = async (soId: number): Promise<number[]> => {
    const rows = await asTenant(() =>
      db().execute<{ pick_list_id: number }>(sql`
        SELECT DISTINCT pll.pick_list_id
          FROM inv_pick_list_lines pll
          JOIN inv_so_lines sol ON sol.org_id = pll.org_id AND sol.id = pll.so_line_id
         WHERE pll.org_id = ${scene.orgId} AND sol.so_id = ${soId}`),
    );
    return rows.map((r) => Number(r.pick_list_id)).sort((a, b) => a - b);
  };

  it("NEO-14: opens a wave for the first order", async () => {
    // Stock through the engine, like everything else here: a hand-written level
    // row is drift the moment reconciliation looks at it.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `neo-wave-stock-${scene.tag}`,
        sourceType: "inv_opening_balance",
        sourceId: `neo-wave-${scene.tag}`,
        reason: "Opening stock for the waveless slice",
        movements: [
          {
            transactionType: "OPENING_BALANCE",
            productVariantId: scene.wavelessVariantId,
            locationId: scene.backBinId,
            quantityDelta: "40.0000",
            unitCost: "2.0000",
          },
        ],
      }),
    );

    await asTenant(() =>
      app.app
        .get(InventorySettingsService)
        .update(scene.orgId, { wavelessPicking: true, wavelessMaxLines: 50 }, scene.userId),
    );

    const soA = await confirmedOrderFor(5, `neo-wave-a-${scene.tag}`);
    const wave = await asTenant(() =>
      app.app.get(PickWaveService).createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [soA],
      }),
    );
    waveId = wave.pickListId;
    expect(wave.lineCount).toBe(1);
    // Allocated, not merely listed: a wave line with no location is a task with
    // no instruction.
    expect(wave.unallocatedLines).toBe(0);
  }, SLICE_TIMEOUT_MS);

  it("NEO-14: attaches a second order to that same open wave, and reserves nothing twice", async () => {
    wavelessSoB = await confirmedOrderFor(6, `neo-wave-b-${scene.tag}`);
    const reservedBefore = await activeReservationCount(wavelessSoB);
    expect(reservedBefore).toBe(1);

    const proposal = await asTenant(() =>
      app.app.get(PickWaveService).proposeWaveJoin(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [wavelessSoB],
      }),
    );
    expect(proposal).toEqual({ join: true, waveId, reason: null });

    const joined = await asTenant(() =>
      app.app.get(PickWaveService).joinWave(scene.orgId, scene.userId, waveId, {
        warehouseId: scene.warehouseId,
        soIds: [wavelessSoB],
      }),
    );
    expect(joined.pickListId).toBe(waveId);
    expect(joined.addedLineCount).toBe(1);
    expect(joined.lineCount).toBe(2);
    expect(joined.unallocatedLines).toBe(0);

    // That wave, and no other. A join that quietly raised a second wave would
    // look identical from the order's side unless somebody counted.
    expect(await waveOfSo(wavelessSoB)).toEqual([waveId]);

    // Joining a wave does not promise the stock again. The reservation already
    // stands against the order line; a second one is the same units held twice.
    expect(await activeReservationCount(wavelessSoB)).toBe(1);
    await expectReconciled("NEO-14 wave joined");
  }, SLICE_TIMEOUT_MS);

  it("NEO-14: refuses to put the same order line on the wave twice", async () => {
    await expect(
      asTenant(() =>
        app.app.get(PickWaveService).joinWave(scene.orgId, scene.userId, waveId, {
          warehouseId: scene.warehouseId,
          soIds: [wavelessSoB],
        }),
      ),
    ).rejects.toThrow(/already on a pick wave/i);
    expect(await waveOfSo(wavelessSoB)).toEqual([waveId]);
  }, SLICE_TIMEOUT_MS);

  it("NEO-14: refuses to add work behind a picker who has already started walking", async () => {
    const [firstLine] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_pick_list_lines
        WHERE org_id = ${scene.orgId} AND pick_list_id = ${waveId}
        ORDER BY id LIMIT 1`),
    );

    await asTenant(() =>
      app.app.get(PickWaveService).claimWave(scene.orgId, scene.userId, waveId),
    );
    await asTenant(() =>
      app.app.get(PickConfirmService).confirmPick(
        scene.orgId,
        scene.userId,
        waveId,
        { pickLineId: firstLine!.id, quantityPicked: "5.0000" },
        `neo-wave-confirm-${scene.tag}`,
      ),
    );

    const soC = await confirmedOrderFor(4, `neo-wave-c-${scene.tag}`);
    // The proposal and the join have to agree, and the join is the one that
    // matters: the picker started between the two calls, and the gate is taken
    // again here rather than trusted from the answer.
    const proposal = await asTenant(() =>
      app.app.get(PickWaveService).proposeWaveJoin(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [soC],
      }),
    );
    expect(proposal.join).toBe(false);

    await expect(
      asTenant(() =>
        app.app.get(PickWaveService).joinWave(scene.orgId, scene.userId, waveId, {
          warehouseId: scene.warehouseId,
          soIds: [soC],
        }),
      ),
    ).rejects.toThrow(/no open wave|room/i);
    expect(await waveOfSo(soC)).toEqual([]);
  }, SLICE_TIMEOUT_MS);

  it("NEO-14: with the setting off, a new order gets a new wave", async () => {
    await asTenant(() =>
      app.app
        .get(InventorySettingsService)
        .update(scene.orgId, { wavelessPicking: false }, scene.userId),
    );

    // A wave nobody has started, so the only thing standing between this order
    // and that wave is the setting.
    const soD = await confirmedOrderFor(3, `neo-wave-d-${scene.tag}`);
    const fresh = await asTenant(() =>
      app.app.get(PickWaveService).createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [soD],
      }),
    );
    const soE = await confirmedOrderFor(2, `neo-wave-e-${scene.tag}`);

    const proposal = await asTenant(() =>
      app.app.get(PickWaveService).proposeWaveJoin(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [soE],
      }),
    );
    expect(proposal).toEqual({
      join: false,
      waveId: null,
      reason: "Waveless picking is switched off",
    });

    // Off means the path is not reached, not reached and ignored.
    await expect(
      asTenant(() =>
        app.app.get(PickWaveService).joinWave(scene.orgId, scene.userId, fresh.pickListId, {
          warehouseId: scene.warehouseId,
          soIds: [soE],
        }),
      ),
    ).rejects.toThrow(/switched off/i);

    const own = await asTenant(() =>
      app.app.get(PickWaveService).createWave(scene.orgId, scene.userId, {
        warehouseId: scene.warehouseId,
        soIds: [soE],
      }),
    );
    expect(own.pickListId).not.toBe(fresh.pickListId);
    expect(await waveOfSo(soE)).toEqual([own.pickListId]);
    await expectReconciled("NEO-14 waveless off");
  }, SLICE_TIMEOUT_MS);

  it("NEO-11: consigned stock is on hand and is never promisable", async () => {
    const consignedVariant = scene.componentAId;
    const ownedBefore = await atp(consignedVariant);

    // Received as the supplier's, through the engine like any other receipt.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `neo-consigned-${scene.tag}`,
        sourceType: "inv_opening_balance",
        sourceId: `neo-consigned-${scene.tag}`,
        reason: "Supplier-owned stock on our shelf",
        movements: [
          {
            transactionType: "OPENING_BALANCE",
            productVariantId: consignedVariant,
            locationId: scene.backBinId,
            ownership: "VENDOR",
            quantityDelta: "10.0000",
            unitCost: "5.0000",
          },
        ],
      }),
    );

    // On hand went up by ten; what may be promised did not move at all.
    const [onHand] = await asTenant(() =>
      db().execute<{ qty: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS qty FROM inv_stock_levels
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${consignedVariant}`),
    );
    expect(Number(onHand!.qty)).toBe(ownedBefore + 10);
    expect(await atp(consignedVariant)).toBe(ownedBefore);

    // Taking title makes it ours, and only then may it be promised.
    await asTenant(() =>
      app.app.get(OwnershipService).convert(
        scene.orgId,
        scene.userId,
        {
          productVariantId: consignedVariant,
          locationId: scene.backBinId,
          quantity: "4.0000",
          fromOwnership: "VENDOR",
          toOwnership: "OWNED",
          unitCost: "5.0000",
        },
        `neo-title-${scene.tag}`,
      ),
    );

    expect(await atp(consignedVariant)).toBe(ownedBefore + 4);
    await expectReconciled("NEO-11 title taken");
  }, SLICE_TIMEOUT_MS);
});
