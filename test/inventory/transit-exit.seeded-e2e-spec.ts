import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { TRANSIT_LOCATION_CODE } from "src/modules/inventory/stock-engine/transit-location.service";
import { InvStockService } from "src/modules/inventory/stock/inv-stock.service";
import { InvStockTransfersService } from "src/modules/inventory/stock/inv-stock-transfers.service";
import { TransitExitService } from "src/modules/inventory/stock/transit-exit.service";
import { SoCoreService } from "src/modules/inventory/sales-orders/so-core.service";
import { SoLifecycleService } from "src/modules/inventory/sales-orders/so-lifecycle.service";
import { PickWaveService } from "src/modules/inventory/picking/pick-wave.service";
import { PickConfirmService } from "src/modules/inventory/picking/pick-confirm.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * R3 — transit has an exit, and a pick task always names a bin.
 *
 * Two defects, one shape: a quantity left standing somewhere with no command
 * that could move it, and nothing anywhere saying so.
 *
 * **Transit.** A2 made a dispatch park its goods at the source warehouse's
 * `TRANSIT` location, so stock on a van is on hand, unsellable and countable.
 * `completeTransfer` takes off that bin only what was actually received, and
 * `cancelTransfer` stops at RESERVED — deliberately, because there was nothing
 * safe to do with dispatched goods. So a short receipt left the difference
 * standing for ever: real units, on the books, promised to nobody, with no route
 * out. These probes take that route and check both halves of it — the units come
 * back to the source and become sellable again, or they leave the books as a
 * recorded loss, and either way the transit bin ends empty and the ledger grew
 * rather than being edited.
 *
 * **The wave line.** `createWave` allocated what it could and inserted the rest
 * with a null location. `confirmPick` then read `input.locationId ??
 * line.locationId`, got null, wrote `quantity_picked` and skipped the projection
 * grain — which is keyed on (variant, location, lot, serial) and so had nothing
 * to key on. The units were in a tote and still on offer. Nothing about the
 * document was wrong; only arithmetic on `inv_stock_levels` catches it.
 *
 * Seeded e2e: this suite needs a real database and does not run without one.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:transfer",
  "inventory:transit:abandon",
  "inventory:sales-orders:create",
  "inventory:sales-orders:read",
  "inventory:sales-orders:confirm",
  "inventory:sales-orders:ship",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  /** Stocked at the source bin. Everything the transfers move. */
  variantId: number;
  /** Deliberately never stocked until a wave has already been planned against it. */
  latecomerVariantId: number;
  sourceWarehouseId: number;
  destWarehouseId: number;
  sourceLocationId: number;
  destLocationId: number;
}

const SEEDED_QTY = 200;
const SHORT_DISPATCH = 20;
const SHORT_RECEIPT = 15;
const STRANDED = SHORT_DISPATCH - SHORT_RECEIPT;
const ABANDON_DISPATCH = 12;
const ABANDON_RECEIPT = 4;
const ABANDONED = ABANDON_DISPATCH - ABANDON_RECEIPT;

describe("[seeded-e2e] transit exit and pick-location resolution", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const transfers = () => app.app.get(InvStockTransfersService);
  const transitExit = () => app.app.get(TransitExitService);
  const waves = () => app.app.get(PickWaveService);
  const picks = () => app.app.get(PickConfirmService);

  /** Availability the way every ATP surface reports it, org-wide or per warehouse. */
  const availability = async (variantId: number, warehouseId?: number) => {
    const result = await asTenant(() =>
      app.app.get(InvStockService).getAvailability(scene.orgId, scene.userId, {
        variantId,
        ...(warehouseId === undefined ? {} : { warehouseId }),
      } as never),
    );
    const typed = result as { onHand: unknown; available: unknown };
    return { onHand: Number(typed.onHand), available: Number(typed.available) };
  };

  const onHandAt = async (locationId: number, variantId?: number) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ on_hand: string }>(sql`
        SELECT COALESCE(SUM(on_hand::numeric), 0)::text AS on_hand
          FROM inv_stock_levels
         WHERE org_id = ${scene.orgId}
           AND product_variant_id = ${variantId ?? scene.variantId}
           AND location_id = ${locationId}`),
    );
    return Number(row!.on_hand);
  };

  const transitLocationId = async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_locations
         WHERE org_id = ${scene.orgId}
           AND warehouse_id = ${scene.sourceWarehouseId}
           AND code = ${TRANSIT_LOCATION_CODE}`),
    );
    return row ? Number(row.id) : null;
  };

  /** Every ledger row this command wrote, so "compensating movement" can be checked as one. */
  const exitLedger = async (transferId: number) =>
    asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        transaction_type: string;
        location_id: number;
        quantity_change: string;
        reason: string | null;
      }>(sql`
        SELECT transaction_type::text AS transaction_type,
               location_id,
               quantity_change::text AS quantity_change,
               reason
          FROM inv_stock_transactions
         WHERE org_id = ${scene.orgId}
           AND reference_type = 'inv_transit_exit'
           AND reference_id = ${String(transferId)}
         ORDER BY id`),
    );

  const ledgerRowCount = async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM inv_stock_transactions
         WHERE org_id = ${scene.orgId}`),
    );
    return Number(row!.count);
  };

  const transferStatus = async (transferId: number) => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ status: string }>(sql`
        SELECT status::text AS status FROM inv_stock_transfers
         WHERE org_id = ${scene.orgId} AND id = ${transferId}`),
    );
    return row!.status;
  };

  const transferLineIds = async (transferId: number) => {
    const rows = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_stock_transfer_lines
         WHERE transfer_id = ${transferId} ORDER BY id`),
    );
    return rows.map((r) => Number(r.id));
  };

  /** Dispatch a transfer and receive less than was sent. The short-receipt scene, end to end. */
  async function shortReceivedTransfer(dispatch: number, receive: number) {
    const created = await asTenant(() =>
      transfers().createTransfer(scene.orgId, scene.userId, {
        fromLocationId: scene.sourceLocationId,
        toLocationId: scene.destLocationId,
        fromWarehouseId: scene.sourceWarehouseId,
        toWarehouseId: scene.destWarehouseId,
        lines: [{ productVariantId: scene.variantId, quantity: dispatch }],
      } as never, `spec-transfer-${crypto.randomUUID()}`),
    );
    const transferId = (created as { id: number }).id;

    await asTenant(() =>
      transfers().dispatchTransfer(
        scene.orgId,
        scene.userId,
        transferId,
        `r3-dispatch-${transferId}`,
      ),
    );
    const [lineId] = await transferLineIds(transferId);
    await asTenant(() =>
      transfers().completeTransfer(
        scene.orgId,
        scene.userId,
        transferId,
        { lines: [{ transferLineId: lineId!, quantityReceived: receive }] },
        `r3-complete-${transferId}`,
      ),
    );
    return { transferId, lineId: lineId! };
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
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
        VALUES (${seeded.orgId}, ${uom.id}, 'Transit goods', ${`TX-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`TX-${tag}-V`}) RETURNING id`);
      const latecomer = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Latecomer', ${`TX-${tag}-L`}) RETURNING id`);
      const sourceWarehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Origin', ${`OR${tag}`}, ${userId}) RETURNING id`);
      const destWarehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Arrival', ${`AR${tag}`}, ${userId}) RETURNING id`);
      const sourceLocation = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${sourceWarehouse.id}, 'Origin bin', ${`OB${tag}`}, 'BIN', true)
        RETURNING id`);
      const destLocation = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${seeded.orgId}, ${destWarehouse.id}, 'Arrival bin', ${`AB${tag}`}, 'BIN', true)
        RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        latecomerVariantId: latecomer.id,
        sourceWarehouseId: sourceWarehouse.id,
        destWarehouseId: destWarehouse.id,
        sourceLocationId: sourceLocation.id,
        destLocationId: destLocation.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `r3-seed-${tag}`,
        sourceType: "r3-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.sourceLocationId,
            quantityDelta: `${SEEDED_QTY}.0000`,
            unitCost: "2.0000",
          },
        ],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  /**
   * The unit's first "done when": a wave confirm with no client location still
   * picks a bin.
   *
   * Staged so the interesting case is reachable at all. The line is planned
   * against a variant with no stock anywhere, so no reservation and no available
   * lot can resolve it and the wave line is created with a null location — which
   * is exactly the row the old confirm silently mis-handled. Stock then arrives,
   * the way it does in a warehouse, and the picker confirms without naming a bin.
   */
  describe("a wave line planned with nowhere to walk", () => {
    let pickListId: number;
    let pickLineId: number;
    let unallocatedAtCreate: number;

    beforeAll(async () => {
      const so = await asTenant(() =>
        app.app.get(SoCoreService).createSo(scene.orgId, scene.userId, {
          orderDate: "2026-08-29",
          currency: "INR",
          warehouseId: scene.sourceWarehouseId,
          lines: [
            {
              productVariantId: scene.latecomerVariantId,
              quantity: 4,
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
          .confirmSo(scene.orgId, soId, scene.userId, `r3-so-confirm-${soId}`),
      );

      const wave = await asTenant(() =>
        waves().createWave(scene.orgId, scene.userId, {
          warehouseId: scene.sourceWarehouseId,
          soIds: [soId],
        }),
      );
      pickListId = wave.pickListId;
      unallocatedAtCreate = wave.unallocatedLines;

      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      pickLineId = Number(detail.lines[0]!.id);
    }, 180_000);

    it("creates the line and says out loud that it needs a decision", async () => {
      // Not deleted, not silently null. The demand is real, so the line is real,
      // and the planner is handed the ids rather than left to find them.
      expect(unallocatedAtCreate).toBe(1);
      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      const line = detail.lines[0]!;
      expect(line.location_id).toBeNull();
      expect(line.needs_decision).toBe(true);
    });

    it("refuses a confirm while there is still nothing to pick", async () => {
      // The defect: this used to succeed. `quantity_picked` moved, the
      // projection grain was skipped for want of a location, and the order was
      // reported picked out of an empty warehouse.
      await expect(
        asTenant(() =>
          picks().confirmPick(
            scene.orgId,
            scene.userId,
            pickListId,
            { pickLineId, quantityPicked: "1.0000" },
            `r3-confirm-nothing-${pickLineId}`,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("wrote nothing at all when it refused", async () => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ quantity_picked: string; location_id: number | null }>(sql`
          SELECT quantity_picked::text AS quantity_picked, location_id
            FROM inv_pick_list_lines
           WHERE org_id = ${scene.orgId} AND id = ${pickLineId}`),
      );
      expect(Number(row!.quantity_picked)).toBe(0);
      expect(row!.location_id).toBeNull();
    });

    it("picks a bin server-side once stock exists, with no location from the client", async () => {
      await asTenant(() =>
        app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
          idempotencyKey: `r3-latecomer-${pickLineId}`,
          sourceType: "r3-fixture",
          sourceId: String(pickLineId),
          movements: [
            {
              transactionType: "PURCHASE",
              productVariantId: scene.latecomerVariantId,
              locationId: scene.sourceLocationId,
              quantityDelta: "10.0000",
              unitCost: "1.0000",
            },
          ],
        }),
      );

      const result = await asTenant(() =>
        picks().confirmPick(
          scene.orgId,
          scene.userId,
          pickListId,
          { pickLineId, quantityPicked: "4.0000" },
          `r3-confirm-resolved-${pickLineId}`,
        ),
      );

      // The bin came from the shared allocator, not from the request.
      expect(result.pickedAtLocationId).toBe(scene.sourceLocationId);
    });

    it("stamped that bin on the line, so it no longer needs a decision", async () => {
      const detail = await asTenant(() =>
        waves().getWave(scene.orgId, scene.userId, pickListId),
      );
      const line = detail.lines[0]!;
      expect(Number(line.location_id)).toBe(scene.sourceLocationId);
      expect(line.needs_decision).toBe(false);
    });

    it("moved the projection, so the picked units stopped being sellable", async () => {
      // The whole point of refusing a null location. `EXPECTED_OUTGOING` is keyed
      // on the pick line's (location, lot, serial); with no location there was no
      // row to write and availability never noticed the pick.
      const org = await availability(scene.latecomerVariantId);
      expect(org.onHand).toBe(10);
      expect(org.available).toBe(6);
    });
  });

  describe("a short receipt, and returning the shortfall to source", () => {
    let transferId: number;
    let lineId: number;

    beforeAll(async () => {
      const short = await shortReceivedTransfer(SHORT_DISPATCH, SHORT_RECEIPT);
      transferId = short.transferId;
      lineId = short.lineId;
    }, 180_000);

    it("strands the difference at the transit location", async () => {
      // The setup, and the state this unit exists to end. It is not a bug that
      // the units are here — they are on hand and unsellable, which is honest.
      // The bug is that nothing could move them.
      const transitId = await transitLocationId();
      expect(transitId).not.toBeNull();
      expect(await onHandAt(transitId!)).toBe(STRANDED);
    });

    it("lists them in the stranded queue, with the document that put them there", async () => {
      const queue = await asTenant(() =>
        transitExit().listStranded(scene.orgId, scene.userId, {
          view: "STRANDED",
          page: 1,
          limit: 50,
        }),
      );
      const row = queue.items.find((item) => Number(item.transfer_id) === transferId);
      expect(row).toBeDefined();
      expect(Number(row!.quantity_stranded)).toBe(STRANDED);
      expect(Number(row!.transfer_line_id)).toBe(lineId);
      expect(Number(row!.transit_on_hand)).toBe(STRANDED);
    });

    it("returns them to the source, and they become promisable again", async () => {
      const before = await availability(scene.variantId, scene.sourceWarehouseId);

      const result = await asTenant(() =>
        transitExit().exitTransit(
          scene.orgId,
          scene.userId,
          {
            transferId,
            disposition: "RETURN_TO_SOURCE",
            reason: "Driver brought the remainder back",
          },
          `r3-return-${transferId}`,
        ),
      );

      expect(result.disposition).toBe("RETURN_TO_SOURCE");
      expect(Number(result.strandedRemaining)).toBe(0);

      const after = await availability(scene.variantId, scene.sourceWarehouseId);
      expect(after.available).toBe(before.available + STRANDED);
      expect(await onHandAt(scene.sourceLocationId)).toBe(
        SEEDED_QTY - SHORT_DISPATCH + STRANDED,
      );
    });

    it("leaves no stranded transit row behind", async () => {
      const transitId = await transitLocationId();
      expect(await onHandAt(transitId!)).toBe(0);

      const queue = await asTenant(() =>
        transitExit().listStranded(scene.orgId, scene.userId, {
          view: "STRANDED",
          page: 1,
          limit: 50,
        }),
      );
      expect(queue.items.some((item) => Number(item.transfer_id) === transferId)).toBe(false);
    });

    it("conserves org-wide on-hand, because a return moves goods rather than losing them", async () => {
      const org = await availability(scene.variantId);
      expect(org.onHand).toBe(SEEDED_QTY);
      expect(org.available).toBe(SEEDED_QTY);
    });

    it("did it with compensating movements, not a delete", async () => {
      // The ledger is append-only. A pair: out of transit, back into the source
      // bin, both carrying the reason somebody typed.
      const rows = await exitLedger(transferId);
      expect(rows).toHaveLength(2);
      const transitId = await transitLocationId();
      expect(rows[0]).toMatchObject({ transaction_type: "TRANSFER_OUT" });
      expect(Number(rows[0]!.location_id)).toBe(transitId);
      expect(Number(rows[0]!.quantity_change)).toBe(-STRANDED);
      expect(rows[1]).toMatchObject({ transaction_type: "TRANSFER_IN" });
      expect(Number(rows[1]!.location_id)).toBe(scene.sourceLocationId);
      expect(Number(rows[1]!.quantity_change)).toBe(STRANDED);
      expect(rows[0]!.reason).toContain("Return to source");
    });

    it("replays a retry rather than returning the units twice", async () => {
      // Every movement here is relative, so a second run would take the quantity
      // off transit again — and the transit bin is shared by every dispatch out
      // of that warehouse, so the second pass eats somebody else's goods.
      const rowsBefore = await ledgerRowCount();
      const replay = await asTenant(() =>
        transitExit().exitTransit(
          scene.orgId,
          scene.userId,
          {
            transferId,
            disposition: "RETURN_TO_SOURCE",
            reason: "Driver brought the remainder back",
          },
          `r3-return-${transferId}`,
        ),
      );
      expect(replay.transferId).toBe(transferId);
      expect(await ledgerRowCount()).toBe(rowsBefore);
      expect(await onHandAt(scene.sourceLocationId)).toBe(
        SEEDED_QTY - SHORT_DISPATCH + STRANDED,
      );
    });

    it("refuses a second exit under a fresh key, because nothing is left in transit", async () => {
      await expect(
        asTenant(() =>
          transitExit().exitTransit(
            scene.orgId,
            scene.userId,
            { transferId, disposition: "WRITE_OFF", reason: "Second bite" },
            `r3-return-again-${transferId}`,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("abandoning what is not coming back", () => {
    let transferId: number;

    beforeAll(async () => {
      const short = await shortReceivedTransfer(ABANDON_DISPATCH, ABANDON_RECEIPT);
      transferId = short.transferId;
    }, 180_000);

    it("takes the loss off the books rather than leaving it in a waypoint", async () => {
      const orgBefore = await availability(scene.variantId);

      const result = await asTenant(() =>
        transitExit().exitTransit(
          scene.orgId,
          scene.userId,
          {
            transferId,
            disposition: "WRITE_OFF",
            reason: "Pallet destroyed in transit, carrier claim raised",
          },
          `r3-abandon-${transferId}`,
        ),
      );

      expect(result.disposition).toBe("WRITE_OFF");
      const orgAfter = await availability(scene.variantId);
      // A write-off is a real loss, so on-hand falls. That is the difference
      // between this and a return, and it is why they cannot be one disposition.
      expect(orgAfter.onHand).toBe(orgBefore.onHand - ABANDONED);
    });

    it("empties the transit location", async () => {
      const transitId = await transitLocationId();
      expect(await onHandAt(transitId!)).toBe(0);
    });

    it("posts it as SCRAP, so a stock report can tell shrinkage from a recount", async () => {
      const rows = await exitLedger(transferId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ transaction_type: "SCRAP" });
      expect(Number(rows[0]!.quantity_change)).toBe(-ABANDONED);
      expect(rows[0]!.reason).toContain("Abandoned in transit");
    });

    it("keeps the transfer COMPLETED, because part of it did arrive", async () => {
      expect(await transferStatus(transferId)).toBe("COMPLETED");
    });
  });

  describe("a journey abandoned before anything arrived", () => {
    let transferId: number;

    beforeAll(async () => {
      const created = await asTenant(() =>
        transfers().createTransfer(scene.orgId, scene.userId, {
          fromLocationId: scene.sourceLocationId,
          toLocationId: scene.destLocationId,
          fromWarehouseId: scene.sourceWarehouseId,
          toWarehouseId: scene.destWarehouseId,
          lines: [{ productVariantId: scene.variantId, quantity: 7 }],
        } as never, `spec-transfer-${crypto.randomUUID()}`),
      );
      transferId = (created as { id: number }).id;
      await asTenant(() =>
        transfers().dispatchTransfer(
          scene.orgId,
          scene.userId,
          transferId,
          `r3-dispatch-lost-${transferId}`,
        ),
      );
    }, 180_000);

    it("shows the whole load as in transit while the transfer is IN_TRANSIT", async () => {
      const queue = await asTenant(() =>
        transitExit().listStranded(scene.orgId, scene.userId, {
          view: "ANY",
          page: 1,
          limit: 50,
        }),
      );
      const row = queue.items.find((item) => Number(item.transfer_id) === transferId);
      expect(row).toBeDefined();
      expect(Number(row!.quantity_stranded)).toBe(7);
      expect(row!.status).toBe("IN_TRANSIT");
    });

    it("is not in the STRANDED view, because the van has not arrived yet", async () => {
      // `ANY` is everything currently in transit, including a van that left an
      // hour ago and is perfectly fine. `STRANDED` is the subset whose journey is
      // over. Conflating them makes the queue unusable on day one.
      const queue = await asTenant(() =>
        transitExit().listStranded(scene.orgId, scene.userId, {
          view: "STRANDED",
          page: 1,
          limit: 50,
        }),
      );
      expect(queue.items.some((item) => Number(item.transfer_id) === transferId)).toBe(false);
    });

    it("returns the whole load and reaches a terminal state", async () => {
      await asTenant(() =>
        transitExit().exitTransit(
          scene.orgId,
          scene.userId,
          {
            transferId,
            disposition: "RETURN_TO_SOURCE",
            reason: "Van turned back before it reached the depot",
          },
          `r3-return-lost-${transferId}`,
        ),
      );

      // An IN_TRANSIT transfer used to have no terminal state but COMPLETED, so
      // an abandoned journey sat in every "goods on a van" report for ever.
      // Nothing arrived, so this one is CANCELLED rather than COMPLETED.
      expect(await transferStatus(transferId)).toBe("CANCELLED");
      const transitId = await transitLocationId();
      expect(await onHandAt(transitId!)).toBe(0);
    });
  });

  describe("bounds", () => {
    it("refuses a transfer that was never dispatched", async () => {
      const created = await asTenant(() =>
        transfers().createTransfer(scene.orgId, scene.userId, {
          fromLocationId: scene.sourceLocationId,
          toLocationId: scene.destLocationId,
          fromWarehouseId: scene.sourceWarehouseId,
          toWarehouseId: scene.destWarehouseId,
          lines: [{ productVariantId: scene.variantId, quantity: 3 }],
        } as never, `spec-transfer-${crypto.randomUUID()}`),
      );
      const pendingId = (created as { id: number }).id;

      await expect(
        asTenant(() =>
          transitExit().exitTransit(
            scene.orgId,
            scene.userId,
            { transferId: pendingId, disposition: "WRITE_OFF", reason: "Nothing to abandon" },
            `r3-never-dispatched-${pendingId}`,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses more than the document actually stranded", async () => {
      // The bound is the reason this matters: the transit bin is per warehouse,
      // so over-stating a line does not fail — it takes another transfer's goods.
      const { transferId, lineId } = await shortReceivedTransfer(6, 2);

      await expect(
        asTenant(() =>
          transitExit().exitTransit(
            scene.orgId,
            scene.userId,
            {
              transferId,
              disposition: "WRITE_OFF",
              reason: "Trying to take more than went missing",
              lines: [{ transferLineId: lineId, quantity: "9.0000" }],
            },
            `r3-overreach-${transferId}`,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const transitId = await transitLocationId();
      expect(await onHandAt(transitId!)).toBe(4);

      // And the honest partial still works, leaving the rest standing.
      const partial = await asTenant(() =>
        transitExit().exitTransit(
          scene.orgId,
          scene.userId,
          {
            transferId,
            disposition: "WRITE_OFF",
            reason: "One box confirmed destroyed",
            lines: [{ transferLineId: lineId, quantity: "1.0000" }],
          },
          `r3-partial-${transferId}`,
        ),
      );
      expect(Number(partial.strandedRemaining)).toBe(3);
      expect(await onHandAt(transitId!)).toBe(3);
      // Units are still out there, so the transfer is not finished with.
      expect(await transferStatus(transferId)).toBe("COMPLETED");
    }, 180_000);
  });
});
