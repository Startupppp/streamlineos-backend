import { randomUUID } from "node:crypto";
import request from "supertest";
import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { LeadTimeService } from "src/modules/inventory/replenishment/forecast/lead-time.service";
import { VendorScorecardService } from "src/modules/inventory/vendors/vendor-scorecard.service";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * C4 — the supplier scorecard, against a fixture whose every number was worked
 * out by hand before the code ran.
 *
 * Centralising arithmetic proves nothing about whether the arithmetic is right,
 * and the spec this replaces demonstrated exactly that: it recomputed each rate
 * inside the test file and asserted the result against itself. The purchases
 * below are deliberately awkward — a receipt that was cancelled, a return that
 * was never posted, a purchase order in another currency, one line short and one
 * delivery late — because each is a way the old implementation was wrong.
 *
 * The hand-worked answers, for the vendor seeded here:
 *
 *   spend        1000 + 500 + 250 + 100 = 1850.0000 INR; the 90 USD order is
 *                named as excluded rather than added to rupees
 *   open POs     1 (the SENT one)
 *   line fill    4 of 5 lines complete            = 80.00%
 *   unit fill    41 of 45 units                   = 91.11%
 *   on time      2 of 3 promised deliveries met   = 66.67%
 *   rejection    1 of 4 received lines            = 25.00%
 *   discrepancy  1 of 4 received lines            = 25.00%
 *   returns      3 of 31 units received           = 9.68%
 *   lead time    receipts at 5, 10 and 15 days: mean 10, p50 10, p90 15
 *
 * The cancelled receipt contributes to none of them, which is the point: it
 * carries ten accepted units and a rejected line, and counting it would move
 * five of the eight numbers above.
 */

interface Scene {
  orgId: string;
  userId: string;
  vendorId: number;
  quietVendorId: number;
  poIds: Record<string, number>;
  postedGrnIds: Record<string, number>;
}

describe(`${SEEDED_HARNESS} supplier scorecard`, () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let strangerOrgId: string;
  let strangerVendorId: number;
  let buyerToken = "";
  let outsiderToken = "";
  const teardowns: Array<() => Promise<void>> = [];

  const scorecards = () => app.app.get(VendorScorecardService);
  const leadTimes = () => app.app.get(LeadTimeService);
  const server = () => app.app.getHttpServer();
  const asTenant = <T>(work: () => Promise<T>, org = scene.orgId): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), org, work);

  async function enableInventory(target: string) {
    const db = app.app.get<Db>(DRIZZLE);
    await runInNewTenantTransaction(db, target, async () => {
      await db.execute(sql`
        INSERT INTO org_modules (org_id, module_key, enabled)
        VALUES (${target}, 'inventory', true) ON CONFLICT DO NOTHING`);
    });
  }

  /** A vendor with nothing but a name, for a second tenant to own. */
  async function seedBareVendor(target: string, userId: string): Promise<number> {
    const db = app.app.get<Db>(DRIZZLE);
    const tag = randomUUID().slice(0, 6);
    return runInNewTenantTransaction(db, target, async () => {
      const [vendor] = await db.execute<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, currency, created_by)
        VALUES (${target}, 'Neighbour supplier', ${`NB${tag}`}, 'INR', ${userId})
        RETURNING id`);
      return vendor!.id;
    });
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("buyer", { permissionKeys: ["inventory:vendors:read"] })
      .addMember("outsider", { permissionKeys: ["inventory:reports:read"] })
      .build();
    teardowns.push(() => seeded.teardown());
    await enableInventory(seeded.orgId);

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const orgId = seeded.orgId;
      const userId = seeded.members["buyer"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;

      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${orgId}, ${uom.id}, 'Sourced goods', ${`SC-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${orgId}, ${product.id}, 'Default', ${`SC-${tag}-V`}) RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, currency, created_by)
        VALUES (${orgId}, 'Mixed supplier', ${`VM${tag}`}, 'INR', ${userId}) RETURNING id`);
      const quietVendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, currency, created_by)
        VALUES (${orgId}, 'Untried supplier', ${`VQ${tag}`}, 'INR', ${userId}) RETURNING id`);

      const addPo = async (
        key: string,
        opts: {
          status: string;
          orderDate: string;
          expected: string | null;
          total: string;
          currency?: string;
        },
      ) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_purchase_orders
            (org_id, vendor_id, po_number, status, order_date, expected_delivery_date,
             subtotal, tax_amount, discount, total, currency, created_by)
          VALUES (${orgId}, ${vendor.id}, ${`PO-${tag}-${key}`}, ${opts.status}::inv_po_status,
                  ${opts.orderDate}::date, ${opts.expected}::date,
                  ${opts.total}, '0', '0', ${opts.total}, ${opts.currency ?? "INR"}, ${userId})
          RETURNING id`);

      const addLine = async (poId: number, quantity: string, received: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_po_lines
            (org_id, po_id, product_variant_id, quantity, quantity_received,
             unit_cost, amount, line_order)
          VALUES (${orgId}, ${poId}, ${variant.id}, ${quantity}, ${received},
                  '10.0000', '10.0000', 0)
          RETURNING id`);

      const addGrn = async (key: string, poId: number, receivedDate: string, status: string) =>
        one<{ id: number }>(sql`
          INSERT INTO inv_grns (org_id, grn_number, po_id, received_date, status, created_by)
          VALUES (${orgId}, ${`GRN-${tag}-${key}`}, ${poId}, ${receivedDate}::date,
                  ${status}::inv_grn_status, ${userId})
          RETURNING id`);

      const addGrnLine = async (
        grnId: number,
        poLineId: number,
        quantity: string,
        quality: string,
        discrepancy: string | null,
      ) =>
        db.execute(sql`
          INSERT INTO inv_grn_lines
            (org_id, grn_id, po_line_id, quantity_received, quality_status, discrepancy_reason)
          VALUES (${orgId}, ${grnId}, ${poLineId}, ${quantity},
                  ${quality}::inv_grn_quality, ${discrepancy}::inv_grn_discrepancy)`);

      // Two lines of ten, both complete, delivered four days early.
      const po1 = await addPo("1", {
        status: "RECEIVED",
        orderDate: "2026-06-01",
        expected: "2026-06-10",
        total: "1000.0000",
      });
      const po1LineA = await addLine(po1.id, "10.0000", "10.0000");
      const po1LineB = await addLine(po1.id, "10.0000", "10.0000");
      const grn1 = await addGrn("1", po1.id, "2026-06-06", "POSTED");
      await addGrnLine(grn1.id, po1LineA.id, "10.0000", "ACCEPTED", null);
      await addGrnLine(grn1.id, po1LineB.id, "10.0000", "ACCEPTED", null);

      // Six of ten, six days late, and refused on arrival.
      const po2 = await addPo("2", {
        status: "RECEIVED",
        orderDate: "2026-06-01",
        expected: "2026-06-10",
        total: "500.0000",
      });
      const po2Line = await addLine(po2.id, "10.0000", "6.0000");
      const grn2 = await addGrn("2", po2.id, "2026-06-16", "POSTED");
      await addGrnLine(grn2.id, po2Line.id, "6.0000", "REJECTED", "SHORT");

      // A receipt somebody walked away from. Ten accepted units and a rejected
      // line that must reach none of the rates.
      const po3 = await addPo("3", {
        status: "CLOSED",
        orderDate: "2026-06-01",
        expected: null,
        total: "250.0000",
      });
      const po3Line = await addLine(po3.id, "10.0000", "10.0000");
      const grn3 = await addGrn("3", po3.id, "2026-06-02", "CANCELLED");
      await addGrnLine(grn3.id, po3Line.id, "10.0000", "REJECTED", "DAMAGED");

      // Still owed to us: counted as open, contributes no spend and no rate.
      const po4 = await addPo("4", {
        status: "SENT",
        orderDate: "2026-06-20",
        expected: "2026-07-20",
        total: "999.0000",
      });

      // Priced in dollars. Adding it to the rupee total would be a lie.
      const po5 = await addPo("5", {
        status: "CLOSED",
        orderDate: "2026-06-01",
        expected: null,
        total: "90.0000",
        currency: "USD",
      });

      // Five of five, ten days out, comfortably inside a month-end promise.
      const po6 = await addPo("6", {
        status: "RECEIVED",
        orderDate: "2026-06-01",
        expected: "2026-06-30",
        total: "100.0000",
      });
      const po6Line = await addLine(po6.id, "5.0000", "5.0000");
      const grn4 = await addGrn("4", po6.id, "2026-06-11", "POSTED");
      await addGrnLine(grn4.id, po6Line.id, "5.0000", "ACCEPTED", null);

      // Three units sent back and accounted for; five more on a return nobody
      // ever posted, which is a proposal rather than a fact about the supplier.
      const postedReturn = await one<{ id: number }>(sql`
        INSERT INTO inv_vendor_returns (org_id, return_number, vendor_id, po_id, status, created_by)
        VALUES (${orgId}, ${`VR-${tag}-P`}, ${vendor.id}, ${po1.id}, 'POSTED', ${userId})
        RETURNING id`);
      const draftReturn = await one<{ id: number }>(sql`
        INSERT INTO inv_vendor_returns (org_id, return_number, vendor_id, po_id, status, created_by)
        VALUES (${orgId}, ${`VR-${tag}-D`}, ${vendor.id}, ${po1.id}, 'DRAFT', ${userId})
        RETURNING id`);
      for (const [returnId, quantity] of [
        [postedReturn.id, "3.0000"],
        [draftReturn.id, "5.0000"],
      ] as const) {
        await db.execute(sql`
          INSERT INTO inv_vendor_return_lines
            (org_id, return_id, product_variant_id, quantity, reason, unit_cost)
          VALUES (${orgId}, ${returnId}, ${variant.id}, ${quantity}, 'DAMAGED', '10.0000')`);
      }

      return {
        orgId,
        userId,
        vendorId: vendor.id,
        quietVendorId: quietVendor.id,
        poIds: {
          complete: po1.id,
          short: po2.id,
          cancelledReceipt: po3.id,
          open: po4.id,
          foreign: po5.id,
          small: po6.id,
        },
        postedGrnIds: { complete: grn1.id, short: grn2.id, small: grn4.id },
      };
    });

    const stranger = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("neighbour", { permissionKeys: ["inventory:vendors:read"] })
      .build();
    teardowns.push(() => stranger.teardown());
    strangerOrgId = stranger.orgId;
    await enableInventory(strangerOrgId);
    strangerVendorId = await seedBareVendor(
      strangerOrgId,
      stranger.members["neighbour"]!.userId,
    );

    buyerToken = `Bearer ${await signSeededToken(app, seeded.members["buyer"]!.userId, seeded.orgId)}`;
    outsiderToken = `Bearer ${await signSeededToken(app, seeded.members["outsider"]!.userId, seeded.orgId)}`;
  }, 300_000);

  afterAll(async () => {
    for (const drop of teardowns) await drop().catch(() => undefined);
    await app.close();
  });

  it("computes the fill rates over purchase order lines, line and unit apart", async () => {
    // Four of five lines complete but 41 of 45 units: an order short one item
    // is a short order, and only the line rate says so.
    const card = await asTenant(() => scorecards().scorecard(scene.orgId, scene.vendorId));
    expect(card.lineFill.percent).toBe("80.00");
    expect(card.lineFill.numerator).toBe("4");
    expect(card.lineFill.denominator).toBe("5");
    expect(card.unitFill.percent).toBe("91.11");
    expect(card.unitFill.numerator).toBe("41.0000");
    expect(card.unitFill.denominator).toBe("45.0000");
  });

  it("counts a delivery late when it beat no promise date", async () => {
    const card = await asTenant(() => scorecards().scorecard(scene.orgId, scene.vendorId));
    expect(card.onTime.percent).toBe("66.67");
    expect(card.onTime.sampleSize).toBe(3);
    expect(card.onTime.sufficient).toBe(false);
  });

  it("ignores an abandoned receipt everywhere it would have counted", async () => {
    // The cancelled GRN carries ten accepted units and a rejected line. If it
    // reached the rates, rejection would be 2 of 5 rather than 1 of 4 and the
    // return rate would be measured against 41 units rather than 31.
    const card = await asTenant(() => scorecards().scorecard(scene.orgId, scene.vendorId));
    expect(card.rejection.numerator).toBe("1");
    expect(card.rejection.denominator).toBe("4");
    expect(card.rejection.percent).toBe("25.00");
    expect(card.discrepancy.percent).toBe("25.00");
    expect(card.returns.denominator).toBe("31.0000");
  });

  it("counts only a posted return against the supplier", async () => {
    // Five of the eight units sent back sit on a return nobody posted. A
    // proposal is not a fact about the vendor, and counting it would report a
    // return rate two and a half times the real one.
    const card = await asTenant(() => scorecards().scorecard(scene.orgId, scene.vendorId));
    expect(card.returns.numerator).toBe("3.0000");
    expect(card.returns.percent).toBe("9.68");
  });

  it("sums spend in the vendor's currency and names what it could not add", async () => {
    const card = await asTenant(() => scorecards().scorecard(scene.orgId, scene.vendorId));
    expect(card.spend.amount).toBe("1850.0000");
    expect(card.spend.currency).toBe("INR");
    expect(card.spend.excludedCurrencies).toEqual(["USD"]);
    expect(card.openPoCount).toBe(1);
  });

  it("reports the same lead time as the estimator, not a second derivation", async () => {
    // The scorecard used to average `sent_at` to the first receipt. Nothing
    // here ever set `sent_at`, so that number was zero observations wide while
    // the lead-time report one screen away had three.
    const card = await asTenant(() => scorecards().scorecard(scene.orgId, scene.vendorId));
    const measured = await asTenant(() =>
      leadTimes().vendorLeadTime(scene.orgId, scene.vendorId),
    );
    expect(card.leadTime.observations).toBe(3);
    expect(card.leadTime.meanDays).toBe(measured.meanDays);
    expect(card.leadTime.p50Days).toBe(measured.p50Days);
    expect(card.leadTime.p90Days).toBe(measured.p90Days);
    expect(card.leadTime.meanDays).toBe(10);
    expect(card.leadTime.p90Days).toBe(15);
    expect(card.leadTime.reliable).toBe(true);
  });

  it("says a vendor with no deliveries is unmeasured rather than perfect", async () => {
    const card = await asTenant(() =>
      scorecards().scorecard(scene.orgId, scene.quietVendorId),
    );
    expect(card.rejection.percent).toBeNull();
    expect(card.onTime.percent).toBeNull();
    expect(card.unitFill.percent).toBeNull();
    expect(card.notes.join(" ")).toMatch(/not the same as a perfect record/);
  });

  it("labels a sample too small to be a trend", async () => {
    const card = await asTenant(() => scorecards().scorecard(scene.orgId, scene.vendorId));
    expect(card.rejection.sufficient).toBe(false);
    expect(card.notes.join(" ")).toMatch(/4 received line\(s\) and describe those lines/);
  });

  it("scores both vendors in one batch without a second round of queries", async () => {
    const cards = await asTenant(() =>
      scorecards().scorecardsFor(scene.orgId, [scene.vendorId, scene.quietVendorId]),
    );
    expect(cards.size).toBe(2);
    expect(cards.get(scene.vendorId)!.lineFill.percent).toBe("80.00");
    expect(cards.get(scene.quietVendorId)!.lineFill.percent).toBeNull();
  });

  it("drills a rate back to the purchase orders and receipts behind it", async () => {
    const page = await asTenant(() =>
      scorecards().deliveries(scene.orgId, scene.vendorId, { page: 1, limit: 100 }),
    );
    expect(page.total).toBe(6);

    const complete = page.items.find((row) => row.poId === scene.poIds["complete"]);
    expect(complete).toMatchObject({
      firstReceiptDate: "2026-06-06",
      daysToReceive: 5,
      onTime: true,
      orderedQty: "20.0000",
      receivedQty: "20.0000",
      lines: 2,
      linesInFull: 2,
      receiptCount: 1,
    });
    expect(complete!.receiptIds).toEqual([scene.postedGrnIds["complete"]]);

    const short = page.items.find((row) => row.poId === scene.poIds["short"]);
    expect(short).toMatchObject({ onTime: false, daysToReceive: 15, linesInFull: 0 });
  });

  it("shows a cancelled receipt as no receipt at all in the drill-through", async () => {
    const page = await asTenant(() =>
      scorecards().deliveries(scene.orgId, scene.vendorId, { page: 1, limit: 100 }),
    );
    const abandoned = page.items.find(
      (row) => row.poId === scene.poIds["cancelledReceipt"],
    );
    expect(abandoned).toMatchObject({
      receiptCount: 0,
      firstReceiptDate: null,
      daysToReceive: null,
      onTime: null,
    });
    expect(abandoned!.receiptIds).toEqual([]);
  });

  it("paginates the drill-through rather than returning every order", async () => {
    const first = await asTenant(() =>
      scorecards().deliveries(scene.orgId, scene.vendorId, { page: 1, limit: 2 }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(6);
    expect(first.totalPages).toBe(3);
  });

  it("serves the scorecard over HTTP to a holder of the read key", async () => {
    const response = await request(server())
      .get(`/inventory/vendors/${scene.vendorId}/performance`)
      .set("Authorization", buyerToken);
    expect(response.status).toBe(200);
    const body = response.body as {
      onTime: { percent: string; sampleSize: number };
      leadTime: { p90Days: number };
    };
    expect(body.onTime.percent).toBe("66.67");
    expect(body.onTime.sampleSize).toBe(3);
    expect(body.leadTime.p90Days).toBe(15);
  });

  it("refuses the scorecard to somebody without the read key", async () => {
    const response = await request(server())
      .get(`/inventory/vendors/${scene.vendorId}/performance`)
      .set("Authorization", outsiderToken);
    expect(response.status).toBe(403);
  });

  it("caps the drill-through page size at a hundred", async () => {
    const response = await request(server())
      .get(`/inventory/vendors/${scene.vendorId}/deliveries?limit=500`)
      .set("Authorization", buyerToken);
    expect(response.status).toBe(400);
  });

  it("answers 404 for another tenant's vendor, never 403", async () => {
    // A 403 on an id from another organisation confirms the id exists, which
    // turns a probe into an existence oracle.
    await expect(
      asTenant(() => scorecards().scorecard(scene.orgId, strangerVendorId)),
    ).rejects.toBeInstanceOf(NotFoundException);

    const response = await request(server())
      .get(`/inventory/vendors/${strangerVendorId}/performance`)
      .set("Authorization", buyerToken);
    expect(response.status).toBe(404);
  });

  it("shows another tenant's vendor no deliveries of ours", async () => {
    const page = await asTenant(() =>
      scorecards().deliveries(scene.orgId, strangerVendorId, { page: 1, limit: 100 }),
    );
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
  });
});
