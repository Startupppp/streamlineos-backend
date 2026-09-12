import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { InvStockTransfersService } from "src/modules/inventory/stock/inv-stock-transfers.service";
import { TransitExitService } from "src/modules/inventory/stock/transit-exit.service";
import { TRANSIT_LOCATION_CODE } from "src/modules/inventory/stock-engine/transit-location.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * T05 — the stranded queue must judge a transfer on stock at the grain the
 * ledger records it.
 *
 * `99ab6c89d` fixed the STRANDED view by asking `inv_stock_levels` whether units
 * are still standing at the waypoint, instead of asking the transfer document
 * what it was owed. That was right, and the `EXISTS` it added matches on
 * `(org, location, variant, lot, serial)`.
 *
 * `inv_stock_levels`' natural key is wider than that. `stock.ts:54-62` includes
 * `coalesce(handling_unit_id, 0)` and `ownership`, both added when NEO widened
 * the grain. So the `EXISTS` can be satisfied by a row that is not this
 * transfer's stock at all — a different pallet, or somebody else's goods — and
 * the transfer stays on the queue after its units have gone.
 *
 * Everything in the existing `transit-exit` fixture is loose and OWNED, where
 * the narrow match and the full key agree. This is the case where they do not.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:stock:read",
  "inventory:stock:adjust",
  "inventory:stock:transfer",
  "inventory:transit:abandon",
];

const SEEDED_QTY = 300;
const DISPATCH = 20;
const RECEIVE = 15;
/** Somebody else's goods, at the same bin and the same (variant, lot, serial). */
const FOREIGN_QTY = 7;

describe("[seeded-e2e] the stranded queue reads stock at the ledger's grain", () => {
  let app: SeededE2eApp;
  let teardown: () => Promise<void>;
  let orgId = "";
  let userId = "";
  let variantId = 0;
  let sourceWarehouseId = 0;
  let sourceLocationId = 0;
  let destWarehouseId = 0;
  let destLocationId = 0;

  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), orgId, work);
  const transfers = () => app.app.get(InvStockTransfersService);
  const transitExit = () => app.app.get(TransitExitService);

  const transitLocationId = async () => {
    const [row] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_locations
        WHERE org_id = ${orgId} AND warehouse_id = ${sourceWarehouseId}
          AND code = ${TRANSIT_LOCATION_CODE}`),
    );
    return row ? Number(row.id) : null;
  };

  const strandedTransferIds = async () => {
    const queue = await asTenant(() =>
      transitExit().listStranded(orgId, userId, { view: "STRANDED", page: 1, limit: 50 } as never),
    );
    return (queue as { items: Array<{ transfer_id: number | string }> }).items.map((i) =>
      Number(i.transfer_id),
    );
  };

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("keeper", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();
    orgId = seeded.orgId;

    const tag = randomUUID().slice(0, 6);
    await runInNewTenantTransaction(db(), orgId, async () => {
      userId = seeded.members["keeper"]!.userId;
      await db().execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${orgId}, 'inventory', true) ON CONFLICT DO NOTHING`);
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db().execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${orgId}, ${uom.id}, 'Grain goods', ${`GR-${tag}`}, ${userId}) RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${orgId}, ${product.id}, 'Default', ${`GR-${tag}-V`}) RETURNING id`);
      const sw = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Origin', ${`OG${tag}`}, ${userId}) RETURNING id`);
      const dw = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Arrival', ${`AV${tag}`}, ${userId}) RETURNING id`);
      const sl = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${orgId}, ${sw.id}, 'Origin bin', ${`OB${tag}`}, 'BIN', true) RETURNING id`);
      const dl = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, is_receivable)
        VALUES (${orgId}, ${dw.id}, 'Arrival bin', ${`AB${tag}`}, 'BIN', true) RETURNING id`);
      variantId = variant.id;
      sourceWarehouseId = sw.id;
      destWarehouseId = dw.id;
      sourceLocationId = sl.id;
      destLocationId = dl.id;
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(orgId, userId, {
        idempotencyKey: `grain-seed-${tag}`,
        sourceType: "grain-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: variantId,
            locationId: sourceLocationId,
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

  it("takes a transfer off the queue once its own units have left the waypoint", async () => {
    const created = (await asTenant(() =>
      transfers().createTransfer(
        orgId,
        userId,
        {
          fromLocationId: sourceLocationId,
          toLocationId: destLocationId,
          fromWarehouseId: sourceWarehouseId,
          toWarehouseId: destWarehouseId,
          lines: [{ productVariantId: variantId, quantity: DISPATCH }],
        } as never,
        `grain-transfer-${randomUUID()}`,
      ),
    )) as { id: number };
    const transferId = created.id;

    await asTenant(() =>
      transfers().dispatchTransfer(orgId, userId, transferId, `grain-dispatch-${transferId}`),
    );
    const [lineRow] = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_stock_transfer_lines
        WHERE org_id = ${orgId} AND transfer_id = ${transferId} ORDER BY id`),
    );
    const lineId = Number(lineRow!.id);
    await asTenant(() =>
      transfers().completeTransfer(
        orgId,
        userId,
        transferId,
        { lines: [{ transferLineId: lineId, quantityReceived: RECEIVE }] } as never,
        `grain-complete-${transferId}`,
      ),
    );

    const transitId = await transitLocationId();
    expect(transitId).not.toBeNull();
    expect(await strandedTransferIds()).toContain(transferId);

    // Somebody else's goods, at the same bin and the same (variant, lot, serial),
    // separated from ours only by a column the queue's EXISTS does not look at.
    await asTenant(() =>
      app.app.get(StockEngineService).execute(orgId, userId, {
        idempotencyKey: `grain-foreign-${randomUUID()}`,
        sourceType: "grain-fixture",
        sourceId: `foreign-${transferId}`,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: variantId,
            locationId: transitId!,
            quantityDelta: `${FOREIGN_QTY}.0000`,
            unitCost: "2.0000",
            ownership: "VENDOR",
          },
        ],
      }),
    );

    // Return our stranded units to source. Ours leave; the VENDOR-owned row stays.
    await asTenant(() =>
      transitExit().exitTransit(
        orgId,
        userId,
        {
          transferId,
          disposition: "RETURN_TO_SOURCE",
          reason: "Returning the shortfall to the source bin",
        } as never,
        `grain-exit-${transferId}`,
      ),
    );

    const [ours] = await asTenant(() =>
      db().execute<{ on_hand: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand FROM inv_stock_levels
        WHERE org_id = ${orgId} AND product_variant_id = ${variantId}
          AND location_id = ${transitId} AND ownership = 'OWNED'`),
    );
    expect(Number(ours!.on_hand)).toBe(0);

    const [foreign] = await asTenant(() =>
      db().execute<{ on_hand: string }>(sql`
        SELECT COALESCE(SUM(on_hand), 0)::text AS on_hand FROM inv_stock_levels
        WHERE org_id = ${orgId} AND product_variant_id = ${variantId}
          AND location_id = ${transitId} AND ownership <> 'OWNED'`),
    );
    expect(Number(foreign!.on_hand)).toBe(FOREIGN_QTY);

    // The transfer's own goods are gone, so it is no longer stranded — however
    // much of somebody else's stock stands at the same bin.
    expect(await strandedTransferIds()).not.toContain(transferId);
  });
});
