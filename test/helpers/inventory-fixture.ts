import { sql } from "drizzle-orm";
import type { INestApplication } from "@nestjs/common";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { ReservationService } from "src/modules/inventory/stock-engine/reservation.service";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";

/**
 * The golden inventory dataset — INV-103.
 *
 * Every movement is posted through the real `StockEngineService` rather than
 * inserted. That is the whole point: a fixture built by INSERT can put the
 * projection and the ledger into a state the engine would never produce, and
 * then a reconciliation test proves nothing. Built through the engine, ledger
 * and projection agree by construction, and any test that finds them disagreeing
 * has found a real defect.
 *
 * Quantities, costs and posting dates are fixed so the arithmetic below is
 * checkable by hand. Identifiers are not — they are database sequences — so the
 * fixture returns them rather than asserting them.
 */

/** Fixed business date, so nothing here depends on when the suite runs. */
export const FIXTURE_POSTING_DATE = "2026-06-01";

export interface FixtureVariant {
  productId: number;
  variantId: number;
  sku: string;
}

export interface InventoryFixture {
  orgId: string;
  userId: string;
  uomId: number;
  categoryId: number;
  warehouses: { main: number; overflow: number };
  locations: { mainBin: number; mainQc: number; overflowBin: number };
  variants: { widget: FixtureVariant; gadget: FixtureVariant; sprocket: FixtureVariant };
  lots: { lotA: number; lotB: number };
  expected: ExpectedTotals;
}

/**
 * What the dataset adds up to.
 *
 * Stated here rather than recomputed in the test, so a test that disagrees with
 * the fixture is a failing test rather than two implementations of the same
 * arithmetic agreeing with each other.
 */
export interface ExpectedTotals {
  /** on_hand by grain, base UOM. */
  onHand: { widgetMain: string; gadgetLotA: string; gadgetLotB: string; sprocketMain: string; sprocketOverflow: string };
  /** Sum of on_hand across every grain in the tenant. */
  totalOnHand: string;
  /** Quality-held quantity, which is a subset of on_hand and not sellable. */
  qualityHeld: string;
  /** Committed by the one reservation. */
  committed: string;
  /** available_to_promise for the widget grain: on_hand − committed − held. */
  widgetAvailable: string;
  /** Ledger rows the dataset writes. */
  ledgerRows: number;
}

const EXPECTED: ExpectedTotals = {
  onHand: {
    widgetMain: "120.0000",      // 100 received + 50 received − 30 issued
    gadgetLotA: "60.0000",       // 60 received; the 10 held below is a subset, not a deduction
    gadgetLotB: "40.0000",
    sprocketMain: "120.0000",    // 200 received − 80 transferred out
    sprocketOverflow: "80.0000", // the other leg of that transfer
  },
  totalOnHand: "420.0000",
  qualityHeld: "10.0000",
  committed: "20.0000",
  widgetAvailable: "100.0000",   // 120 on hand − 20 committed
  // widget 3 (two receipts, one issue) + gadget 3 (two receipts, one hold)
  // + sprocket 3 (one receipt, two transfer legs).
  ledgerRows: 9,
};

interface Ctx {
  db: Db;
  engine: StockEngineService;
  reservations: ReservationService;
  orgId: string;
  userId: string;
  /** Prefix keeping two fixtures in one database from colliding on unique codes. */
  tag: string;
}

async function one<T extends Record<string, unknown>>(db: Db, query: ReturnType<typeof sql>): Promise<T> {
  const rows = await db.execute<T>(query);
  const row = rows[0];
  if (!row) throw new Error("fixture insert returned no row");
  return row;
}

async function seedCatalogue(ctx: Ctx) {
  const { db, orgId, userId, tag } = ctx;
  const uom = await one<{ id: number }>(db, sql`
    INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
    VALUES (${orgId}, ${`Each ${tag}`}, ${`EA${tag}`}, true) RETURNING id`);
  const category = await one<{ id: number }>(db, sql`
    INSERT INTO inv_categories (org_id, name) VALUES (${orgId}, ${`Components ${tag}`}) RETURNING id`);

  async function product(alias: string, tracking: string): Promise<FixtureVariant> {
    const sku = `${alias}-${tag}`;
    const p = await one<{ id: number }>(db, sql`
      INSERT INTO inv_products (org_id, uom_id, category_id, name, sku, tracking_method, created_by)
      VALUES (${orgId}, ${uom.id}, ${category.id}, ${alias}, ${sku}, ${sql.raw(`'${tracking}'`)}, ${userId})
      RETURNING id`);
    const v = await one<{ id: number }>(db, sql`
      INSERT INTO inv_product_variants (org_id, product_id, name, sku)
      VALUES (${orgId}, ${p.id}, 'Default', ${`${sku}-V1`}) RETURNING id`);
    return { productId: p.id, variantId: v.id, sku };
  }

  return {
    uomId: uom.id,
    categoryId: category.id,
    widget: await product("WIDGET", "NONE"),
    gadget: await product("GADGET", "LOT"),
    sprocket: await product("SPROCKET", "NONE"),
  };
}

async function seedFacilities(ctx: Ctx) {
  const { db, orgId, userId, tag } = ctx;
  async function warehouse(name: string, code: string) {
    return one<{ id: number }>(db, sql`
      INSERT INTO inv_warehouses (org_id, name, code, created_by)
      VALUES (${orgId}, ${name}, ${code}, ${userId}) RETURNING id`);
  }
  async function location(warehouseId: number, name: string, code: string, type: string) {
    return one<{ id: number }>(db, sql`
      INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
      VALUES (${orgId}, ${warehouseId}, ${name}, ${code}, ${sql.raw(`'${type}'`)}) RETURNING id`);
  }
  const main = await warehouse(`Main ${tag}`, `MAIN${tag}`);
  const overflow = await warehouse(`Overflow ${tag}`, `OVF${tag}`);
  return {
    warehouses: { main: main.id, overflow: overflow.id },
    locations: {
      mainBin: (await location(main.id, "Bin A1", `MB${tag}`, "BIN")).id,
      mainQc: (await location(main.id, "Quarantine", `MQ${tag}`, "QUARANTINE")).id,
      overflowBin: (await location(overflow.id, "Bin B1", `OB${tag}`, "BIN")).id,
    },
  };
}

/**
 * Every movement, through the engine, each with its own idempotency key.
 *
 * Keys are derived from the tag so a re-run against the same tenant replays the
 * stored result instead of double-posting — which is what makes the fixture
 * idempotent rather than merely repeatable.
 */
async function postMovements(
  ctx: Ctx,
  cat: Awaited<ReturnType<typeof seedCatalogue>>,
  fac: Awaited<ReturnType<typeof seedFacilities>>,
  lots: { lotA: number; lotB: number },
) {
  const { engine, orgId, userId, tag } = ctx;
  const { mainBin, overflowBin } = fac.locations;

  const post = (name: string, movements: Parameters<typeof engine.execute>[2]["movements"], sourceType = "fixture") =>
    engine.execute(orgId, userId, {
      idempotencyKey: `fixture-${tag}-${name}`,
      sourceType,
      sourceId: `${tag}:${name}`,
      postingDate: FIXTURE_POSTING_DATE,
      movements,
    });

  await post("widget-receipt-1", [
    { transactionType: "PURCHASE", productVariantId: cat.widget.variantId, locationId: mainBin, quantityDelta: "100.0000", unitCost: "10.0000" },
  ]);
  await post("widget-receipt-2", [
    { transactionType: "PURCHASE", productVariantId: cat.widget.variantId, locationId: mainBin, quantityDelta: "50.0000", unitCost: "12.0000" },
  ]);
  await post("widget-issue", [
    { transactionType: "SALE", productVariantId: cat.widget.variantId, locationId: mainBin, quantityDelta: "-30.0000" },
  ]);

  await post("gadget-receipt-lot-a", [
    { transactionType: "PURCHASE", productVariantId: cat.gadget.variantId, locationId: mainBin, lotId: lots.lotA, quantityDelta: "60.0000", unitCost: "5.0000" },
  ]);
  await post("gadget-receipt-lot-b", [
    { transactionType: "PURCHASE", productVariantId: cat.gadget.variantId, locationId: mainBin, lotId: lots.lotB, quantityDelta: "40.0000", unitCost: "5.5000" },
  ]);
  // A hold does not move goods out of on_hand — it marks a subset of what is
  // physically there as unsellable, which is why availability subtracts it.
  await post("gadget-hold-lot-a", [
    { transactionType: "QUARANTINE_IN", productVariantId: cat.gadget.variantId, locationId: mainBin, lotId: lots.lotA, quantityDelta: "10.0000", qualityBucket: "QUALITY_HOLD" },
  ]);

  await post("sprocket-receipt", [
    { transactionType: "PURCHASE", productVariantId: cat.sprocket.variantId, locationId: mainBin, quantityDelta: "200.0000", unitCost: "2.0000" },
  ]);
  // Both legs in one command, so the transfer is atomic and the two rows share
  // an idempotency key — a retry cannot land one leg without the other.
  await post("sprocket-transfer", [
    { transactionType: "TRANSFER_OUT", productVariantId: cat.sprocket.variantId, locationId: mainBin, quantityDelta: "-80.0000" },
    { transactionType: "TRANSFER_IN", productVariantId: cat.sprocket.variantId, locationId: overflowBin, quantityDelta: "80.0000" },
  ]);
}

/**
 * Builds the dataset inside `orgId`, through the real services.
 *
 * The caller supplies an organisation that already has a member holding
 * `inventory:warehouses:scope-all` — the engine asserts warehouse scope on every
 * movement, and a user with no warehouses cannot post one.
 */
export async function buildInventoryFixture(
  app: INestApplication,
  orgId: string,
  userId: string,
  tag: string,
): Promise<InventoryFixture> {
  const db = app.get<Db>(DRIZZLE);
  const ctx: Ctx = {
    db,
    engine: app.get(StockEngineService),
    reservations: app.get(ReservationService),
    orgId,
    userId,
    tag,
  };

  return runInNewTenantTransaction(db, orgId, async () => {
    const cat = await seedCatalogue(ctx);
    const fac = await seedFacilities(ctx);

    const lotA = await one<{ id: number }>(db, sql`
      INSERT INTO inv_lots (org_id, product_variant_id, lot_number, expiry_date)
      VALUES (${orgId}, ${cat.gadget.variantId}, ${`LOT-A-${tag}`}, '2027-01-31') RETURNING id`);
    const lotB = await one<{ id: number }>(db, sql`
      INSERT INTO inv_lots (org_id, product_variant_id, lot_number, expiry_date)
      VALUES (${orgId}, ${cat.gadget.variantId}, ${`LOT-B-${tag}`}, '2027-06-30') RETURNING id`);
    const lots = { lotA: lotA.id, lotB: lotB.id };

    await postMovements(ctx, cat, fac, lots);

    await ctx.reservations.createReservation(orgId, userId, {
      sourceType: "fixture",
      sourceId: `${tag}:widget-reservation`,
      productVariantId: cat.widget.variantId,
      warehouseId: fac.warehouses.main,
      locationId: fac.locations.mainBin,
      qty: "20.0000",
    });

    return {
      orgId,
      userId,
      uomId: cat.uomId,
      categoryId: cat.categoryId,
      warehouses: fac.warehouses,
      locations: fac.locations,
      variants: { widget: cat.widget, gadget: cat.gadget, sprocket: cat.sprocket },
      lots,
      expected: EXPECTED,
    };
  });
}
