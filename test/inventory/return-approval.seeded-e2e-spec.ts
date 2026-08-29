import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { availableQtySumSql } from "src/modules/inventory/stock-engine/available-sql";
import { cmpDec, subDec } from "src/modules/inventory/stock-engine/decimal";
import { CustomerReturnsService } from "src/modules/inventory/returns/customer-returns.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * B9 — a return is approved before it is posted, and it cannot claim more than
 * was shipped.
 *
 * The "done when" of the unit, in order: an uninspected post fails; inspect,
 * approve and post puts the goods back into availability; a duplicate post
 * changes nothing. The rest of this file is the boundary the same command has
 * to hold — the shipped ceiling, the lot that never went out, and the credit
 * reference that must never be the reason stock stays off the shelf.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  locationId: number;
  lotId: number;
  otherLotId: number;
  tag: string;
}

interface DraftLine {
  quantity: string;
  lotId?: number;
}

describe("[seeded-e2e] customer return approval", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;
  let shipmentSeq = 0;

  const returns = () => app.app.get(CustomerReturnsService);
  const db = () => app.app.get<Db>(DRIZZLE);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(db(), scene.orgId, work);

  /**
   * One shipment per return, deliberately. Every return in this file is raised
   * against its own dispatch, so the "already returned against this document"
   * arithmetic does not accumulate across unrelated tests and turn the last one
   * into a false failure.
   */
  async function shipped(lines: DraftLine[]): Promise<number> {
    shipmentSeq += 1;
    const number = `SHP-${scene.tag}-${shipmentSeq}`;
    return asTenant(async () => {
      const [ship] = await db().execute<{ id: number }>(sql`
        INSERT INTO inv_shipments (org_id, shipment_number, status, shipped_at, created_by)
        VALUES (${scene.orgId}, ${number}, 'SHIPPED', now(), ${scene.userId})
        RETURNING id`);
      for (const line of lines) {
        await db().execute(sql`
          INSERT INTO inv_shipment_lines (org_id, shipment_id, product_variant_id, quantity, lot_id)
          VALUES (${scene.orgId}, ${ship!.id}, ${scene.variantId}, ${line.quantity},
                  ${line.lotId ?? null})`);
      }
      return Number(ship!.id);
    });
  }

  async function draftReturn(
    shipmentId: number,
    lines: DraftLine[],
  ): Promise<{ returnId: number; lineIds: number[] }> {
    const created = await asTenant(() =>
      returns().create(scene.orgId, scene.userId, {
        shipmentId,
        lines: lines.map((line) => ({
          productVariantId: scene.variantId,
          quantity: line.quantity,
          reason: "Customer changed their mind",
          targetLocationId: scene.locationId,
          ...(line.lotId !== undefined ? { lotId: line.lotId } : {}),
        })),
      }),
    );
    const returnId = (created as { id: number }).id;
    const rows = await asTenant(() =>
      db().execute<{ id: number }>(sql`
        SELECT id FROM inv_customer_return_lines
        WHERE org_id = ${scene.orgId} AND return_id = ${returnId}
        ORDER BY id ASC`),
    );
    return { returnId, lineIds: rows.map((r) => Number(r.id)) };
  }

  const inspect = (returnId: number, lineId: number, disposition: "RESTOCK" | "QUARANTINE" | "SCRAP" | "RETURN_TO_VENDOR") =>
    asTenant(() =>
      returns().inspectLine(scene.orgId, scene.userId, returnId, { lineId, disposition }),
    );

  const approve = (returnId: number, creditReference?: string) =>
    asTenant(() =>
      returns().approve(
        scene.orgId,
        returnId,
        scene.userId,
        creditReference === undefined ? {} : { creditReference },
      ),
    );

  const post = (returnId: number, key = `ret-${randomUUID()}`) =>
    asTenant(() => returns().post(scene.orgId, returnId, scene.userId, key, {}));

  /** Availability, through the one formula, at the grain this fixture uses. */
  async function atp(): Promise<string> {
    const [row] = await asTenant(() =>
      db().execute<{ available: string }>(sql`
        SELECT ${availableQtySumSql("sl")}::text AS available
        FROM inv_stock_levels sl
        WHERE sl.org_id = ${scene.orgId} AND sl.product_variant_id = ${scene.variantId}`),
    );
    return row?.available ?? "0";
  }

  async function onHand(): Promise<string> {
    const [row] = await asTenant(() =>
      db().execute<{ on_hand: string }>(sql`
        SELECT COALESCE(SUM(sl.on_hand), 0)::text AS on_hand
        FROM inv_stock_levels sl
        WHERE sl.org_id = ${scene.orgId} AND sl.product_variant_id = ${scene.variantId}`),
    );
    return row?.on_hand ?? "0";
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("clerk", {
        permissionKeys: [
          "inventory:warehouses:scope-all",
          "inventory:customer-returns:manage",
          "inventory:stock:read",
          "inventory:stock:adjust",
        ],
      })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const database = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(database, seeded.orgId, async () => {
      const userId = seeded.members["clerk"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await database.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Returned goods', ${`RA-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RA-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MA${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Returns', ${`RA${tag}`}, 'BIN') RETURNING id`);
      const lot = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number)
        VALUES (${seeded.orgId}, ${variant.id}, ${`LOT-${tag}-A`}) RETURNING id`);
      const otherLot = await one<{ id: number }>(sql`
        INSERT INTO inv_lots (org_id, product_variant_id, lot_number)
        VALUES (${seeded.orgId}, ${variant.id}, ${`LOT-${tag}-B`}) RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        locationId: location.id,
        lotId: lot.id,
        otherLotId: otherLot.id,
        tag,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `ret-approval-seed-${tag}`,
        sourceType: "return-approval-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "100.0000",
            unitCost: "1.0000",
          },
        ],
      }),
    );
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("refuses to post a return nobody has looked at", async () => {
    const shipmentId = await shipped([{ quantity: "5.0000" }]);
    const { returnId } = await draftReturn(shipmentId, [{ quantity: "2.0000" }]);

    // Two refusals, one per gate: the state machine will not let a DRAFT post,
    // and the approval that would clear the state machine will not accept an
    // uninspected line either. Only asserting the first would pass against a
    // service that had quietly dropped INV-209.
    await expect(post(returnId)).rejects.toThrow(BadRequestException);
    await expect(approve(returnId)).rejects.toThrow(BadRequestException);

    const [row] = await asTenant(() =>
      db().execute<{ status: string }>(sql`
        SELECT status FROM inv_customer_returns
        WHERE org_id = ${scene.orgId} AND id = ${returnId}`),
    );
    expect(row!.status).toBe("DRAFT");
  });

  it("inspect, approve and post puts the goods back into availability", async () => {
    const before = await atp();
    const shipmentId = await shipped([{ quantity: "5.0000" }]);
    const { returnId, lineIds } = await draftReturn(shipmentId, [{ quantity: "3.0000" }]);

    await inspect(returnId, lineIds[0]!, "RESTOCK");
    await approve(returnId);
    await post(returnId);

    expect(subDec(await atp(), before)).toBe("3.0000");
  });

  it("a duplicate post moves nothing a second time", async () => {
    const shipmentId = await shipped([{ quantity: "5.0000" }]);
    const { returnId, lineIds } = await draftReturn(shipmentId, [{ quantity: "2.0000" }]);
    await inspect(returnId, lineIds[0]!, "RESTOCK");
    await approve(returnId);

    const key = `ret-dup-${randomUUID()}`;
    await post(returnId, key);
    const afterFirst = await atp();

    // The retry a flaky network produces: same key, same command. It replays.
    await expect(post(returnId, key)).resolves.toBeDefined();
    expect(await atp()).toBe(afterFirst);

    // And the retry a double-clicked button produces: a fresh key against a
    // document that has already posted. The status is the second gate, and it
    // must not move stock either.
    await expect(post(returnId)).resolves.toBeDefined();
    expect(await atp()).toBe(afterFirst);

    const ledger = await asTenant(() =>
      db().execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM inv_stock_transactions
        WHERE org_id = ${scene.orgId}
          AND reference_type = 'inv_customer_return'
          AND reference_id = ${String(returnId)}`),
    );
    expect(ledger[0]!.count).toBe("1");
  });

  it("refuses to return more than was shipped", async () => {
    const shipmentId = await shipped([{ quantity: "4.0000" }]);
    await expect(
      draftReturn(shipmentId, [{ quantity: "5.0000" }]),
    ).rejects.toThrow(BadRequestException);
  });

  it("counts what has already come back against the same shipment", async () => {
    // Two returns of four against a shipment of six. Each is under the ceiling
    // on its own, which is exactly how a per-document check that forgets the
    // earlier return lets seven units back in.
    const shipmentId = await shipped([{ quantity: "6.0000" }]);
    await draftReturn(shipmentId, [{ quantity: "4.0000" }]);
    await expect(
      draftReturn(shipmentId, [{ quantity: "4.0000" }]),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses a lot that was never on the shipment", async () => {
    const shipmentId = await shipped([{ quantity: "5.0000", lotId: scene.lotId }]);
    await expect(
      draftReturn(shipmentId, [{ quantity: "1.0000", lotId: scene.otherLotId }]),
    ).rejects.toThrow(BadRequestException);

    // The control: the lot that did ship is returnable.
    await expect(
      draftReturn(shipmentId, [{ quantity: "1.0000", lotId: scene.lotId }]),
    ).resolves.toBeDefined();
  });

  it("posts the stock whether or not a credit was raised", async () => {
    // Item 5. The credit reference is a pointer into whatever system issues
    // credit notes. It is recorded, and it is never the reason goods stay off
    // the shelf — a missing adapter must not become a silent stock skip.
    const withCredit = await shipped([{ quantity: "2.0000" }]);
    const a = await draftReturn(withCredit, [{ quantity: "2.0000" }]);
    await inspect(a.returnId, a.lineIds[0]!, "RESTOCK");
    await approve(a.returnId, "CN-2026-0007");

    const before = await atp();
    await post(a.returnId);
    expect(subDec(await atp(), before)).toBe("2.0000");

    const [row] = await asTenant(() =>
      db().execute<{ credit_reference: string | null; approved_at: string | null; approved_by: string | null }>(sql`
        SELECT credit_reference, approved_at, approved_by FROM inv_customer_returns
        WHERE org_id = ${scene.orgId} AND id = ${a.returnId}`),
    );
    expect(row!.credit_reference).toBe("CN-2026-0007");
    expect(row!.approved_at).not.toBeNull();
    expect(row!.approved_by).toBe(scene.userId);

    const withoutCredit = await shipped([{ quantity: "2.0000" }]);
    const b = await draftReturn(withoutCredit, [{ quantity: "2.0000" }]);
    await inspect(b.returnId, b.lineIds[0]!, "RESTOCK");
    await approve(b.returnId);
    const beforeB = await atp();
    await post(b.returnId);
    expect(subDec(await atp(), beforeB)).toBe("2.0000");
  });

  it("RETURN_TO_VENDOR takes the goods in and keeps them out of availability", async () => {
    const shipmentId = await shipped([{ quantity: "2.0000" }]);
    const { returnId, lineIds } = await draftReturn(shipmentId, [{ quantity: "2.0000" }]);
    await inspect(returnId, lineIds[0]!, "RETURN_TO_VENDOR");
    await approve(returnId);

    const beforeAtp = await atp();
    const beforeOnHand = await onHand();
    await post(returnId);

    // Physically present, administratively blocked: on-hand rises, available
    // does not. Anything else would either lose the goods or offer them for
    // sale while they wait for the vendor RMA.
    expect(subDec(await onHand(), beforeOnHand)).toBe("2.0000");
    expect(cmpDec(await atp(), beforeAtp)).toBe(0);
  });

  it("cancels from APPROVED, and then refuses to post", async () => {
    const shipmentId = await shipped([{ quantity: "1.0000" }]);
    const { returnId, lineIds } = await draftReturn(shipmentId, [{ quantity: "1.0000" }]);
    await inspect(returnId, lineIds[0]!, "SCRAP");
    await approve(returnId);

    await asTenant(() => returns().cancel(scene.orgId, returnId));
    await expect(post(returnId)).rejects.toThrow(BadRequestException);
  });

  it("a scrapped return posts, moves no stock, and is still idempotent", async () => {
    // The case the claim shape exists for: every line scrapped produces no
    // movements at all, so a claim taken only around the engine call would leave
    // this document unguarded and a retry would raise it twice.
    const shipmentId = await shipped([{ quantity: "1.0000" }]);
    const { returnId, lineIds } = await draftReturn(shipmentId, [{ quantity: "1.0000" }]);
    await inspect(returnId, lineIds[0]!, "SCRAP");
    await approve(returnId);

    const before = await onHand();
    const key = `ret-scrap-${randomUUID()}`;
    await post(returnId, key);
    await expect(post(returnId, key)).resolves.toBeDefined();

    expect(await onHand()).toBe(before);
    const claims = await asTenant(() =>
      db().execute<{ status: string }>(sql`
        SELECT status FROM inv_idempotency_keys
        WHERE org_id = ${scene.orgId} AND idempotency_key = ${key}`),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.status).toBe("COMPLETED");
  });
});
