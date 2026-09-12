import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { PoService } from "src/modules/inventory/purchase-orders/po.service";
import { GrnService } from "src/modules/inventory/purchase-orders/grn.service";
import { VendorReturnsService } from "src/modules/inventory/returns/vendor-returns.service";
import { INVENTORY_COMMAND_EVENTS } from "src/modules/inventory/stock-engine/command-events";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { outboxEventsFor } from "test/helpers/outbox-events";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-201 — receiving, and what a receipt is allowed to forget.
 *
 * Two defects sit behind these probes. The quantity a receiver typed reached
 * the stock ledger as `Number(qty).toFixed(4)`, which is float arithmetic on
 * the one value the inventory PRD forbids it for; and the receipt recorded what
 * arrived while forgetting what was expected, so a short delivery was
 * indistinguishable from a partial one everybody had agreed to.
 */
const PERMISSIONS = [
  "inventory:warehouses:scope-all",
  "inventory:purchase-orders:create",
  "inventory:purchase-orders:receive",
  "inventory:stock:read",
] as const;

interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  /** A LOT-tracked SKU, for the expiry gate. */
  lotVariantId: number;
  /** A unit of twelve on the plain SKU, for the conversion snapshot. */
  caseUomId: number;
  warehouseId: number;
  locationId: number;
  vendorId: number;
}

describe("[seeded-e2e] goods receipt discrepancies and exact quantities", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  /** A sent order for `ordered` units, and the id of its single line. */
  async function sentOrder(ordered: number, variantId?: number) {
    const po = await asTenant(() =>
      app.app.get(PoService).createPo(scene.orgId, scene.userId, {
        vendorId: scene.vendorId,
        orderDate: "2026-08-01",
        warehouseId: scene.warehouseId,
        currency: "INR",
        lines: [
          {
            productVariantId: variantId ?? scene.variantId,
            quantity: ordered,
            unitCost: "10.0000",
            taxRate: "0",
            lineOrder: 0,
          },
        ],
      }),
    );
    await asTenant(() => app.app.get(PoService).sendPo(scene.orgId, po.id, scene.userId));
    const [line] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_po_lines WHERE org_id = ${scene.orgId} AND po_id = ${po.id}`),
    );
    return { poId: po.id, poLineId: line!.id };
  }

  const receive = (
    poId: number,
    line: Record<string, unknown>,
  ): Promise<unknown> =>
    asTenant(() =>
      app.app.get(GrnService).receiveGoods(
        scene.orgId,
        poId,
        scene.userId,
        `grn-${randomUUID()}`,
        {
          receivedDate: "2026-08-02",
          locationId: scene.locationId,
          lines: [line],
        } as never,
      ),
    );

  const grnLinesFor = (poLineId: number) =>
    asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        quantity_received: string;
        quantity_expected: string | null;
        discrepancy_reason: string | null;
      }>(sql`
        SELECT quantity_received, quantity_expected, discrepancy_reason
        FROM inv_grn_lines
        WHERE org_id = ${scene.orgId} AND po_line_id = ${poLineId}
        ORDER BY id`),
    );

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("receiver", { permissionKeys: PERMISSIONS })
      .build();
    teardown = () => seeded.teardown();

    const tag = randomUUID().slice(0, 6);
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["receiver"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Received goods', ${`RC-${tag}`}, 'NONE', ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RC-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Dock', ${`DK${tag}`}, 'BIN') RETURNING id`);
      const vendor = await one<{ id: number }>(sql`
        INSERT INTO inv_vendors (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Perf vendor', ${`VN${tag}`}, ${userId}) RETURNING id`);

      const lotProduct = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, tracking_method, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Batched goods', ${`LT-${tag}`}, 'LOT', ${userId})
        RETURNING id`);
      const lotVariant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${lotProduct.id}, 'Default', ${`LT-${tag}-V`}) RETURNING id`);

      const caseUom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Case ${tag}`}, ${`C${tag}`}, false) RETURNING id`);
      await db.execute(sql`
        INSERT INTO inv_product_uom_conversions (org_id, product_id, uom_id, factor_to_base)
        VALUES (${seeded.orgId}, ${product.id}, ${caseUom.id}, '12.00000000')`);

      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        lotVariantId: lotVariant.id,
        caseUomId: caseUom.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        vendorId: vendor.id,
      };
    });
  }, 240_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await app.close();
  });

  it("carries a fractional quantity to the ledger without rounding it", async () => {
    // 33.3333 is chosen because it survives neither a float round-trip nor a
    // toFixed(2) intact. The ledger row must read back exactly what arrived.
    const { poId, poLineId } = await sentOrder(100);
    await receive(poId, {
      poLineId,
      quantityReceived: "33.3333",
      qualityStatus: "ACCEPTED",
    });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.quantity_received).toBe("33.3333");

    const [ledger] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ quantity_change: string }>(sql`
        SELECT quantity_change FROM inv_stock_transactions
        WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}
        ORDER BY id DESC LIMIT 1`),
    );
    expect(ledger!.quantity_change).toBe("33.3333");
  });

  it("records what the line still owed, so a short receipt is legible later", async () => {
    const { poId, poLineId } = await sentOrder(50);
    await receive(poId, {
      poLineId,
      quantityReceived: "20.0000",
      qualityStatus: "ACCEPTED",
      discrepancyReason: "SHORT",
    });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.quantity_expected).toBe("50.0000");
    expect(grnLine!.quantity_received).toBe("20.0000");
    expect(grnLine!.discrepancy_reason).toBe("SHORT");
  });

  it("leaves no discrepancy on a line that matched", async () => {
    // The control. Without it, every assertion above would also pass against a
    // service that stamped a reason on every receipt it ever wrote.
    const { poId, poLineId } = await sentOrder(40);
    await receive(poId, {
      poLineId,
      quantityReceived: "40.0000",
      qualityStatus: "ACCEPTED",
    });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.discrepancy_reason).toBeNull();
    expect(grnLine!.quantity_expected).toBe("40.0000");
  });

  it("expects less on a second receipt, because the first one counted", async () => {
    // The snapshot is per receipt, not per line: after 30 of 100 arrives the
    // next delivery is expected to owe 70, and a receipt that recorded the
    // original 100 both times would be lying about the second one.
    const { poId, poLineId } = await sentOrder(100);
    await receive(poId, { poLineId, quantityReceived: "30.0000", qualityStatus: "ACCEPTED" });
    await receive(poId, { poLineId, quantityReceived: "70.0000", qualityStatus: "ACCEPTED" });

    const lines = await grnLinesFor(poLineId);
    expect(lines.map((l) => l.quantity_expected)).toEqual(["100.0000", "70.0000"]);
  });

  it("refuses a receipt beyond the over-receipt tolerance", async () => {
    // Tolerance defaults to 0%, so anything past the outstanding quantity is
    // refused rather than silently absorbed.
    const { poId, poLineId } = await sentOrder(10);
    await expect(
      receive(poId, {
        poLineId,
        quantityReceived: "10.0001",
        qualityStatus: "ACCEPTED",
      }),
    ).rejects.toThrow(BadRequestException);

    expect(await grnLinesFor(poLineId)).toHaveLength(0);
  });

  it("accepts exactly the outstanding quantity at the tolerance boundary", async () => {
    // The boundary the epsilon used to blur. Without this the refusal above
    // would also pass against a guard that rejected every full receipt.
    const { poId, poLineId } = await sentOrder(10);
    await receive(poId, { poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED" });

    const [grnLine] = await grnLinesFor(poLineId);
    expect(grnLine!.quantity_received).toBe("10.0000");
    expect(grnLine!.discrepancy_reason).toBeNull();
  });

  describe("a receipt sent twice under one key", () => {
    const receiveWithKey = (poId: number, key: string, line: Record<string, unknown>) =>
      asTenant(() =>
        app.app.get(GrnService).receiveGoods(scene.orgId, poId, scene.userId, key, {
          receivedDate: "2026-08-02",
          locationId: scene.locationId,
          lines: [line],
        } as never),
      );

    const receivedOnLine = async (poLineId: number) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ quantity_received: string }>(sql`
          SELECT quantity_received FROM inv_po_lines
          WHERE org_id = ${scene.orgId} AND id = ${poLineId}`),
      );
      return row!.quantity_received;
    };

    it("posts one receipt when nothing on the delivery was accepted", async () => {
      // A3, and the branch that had no protection at all. With every line
      // REJECTED there are no movements, so the engine — which is where the key
      // was claimed — is never called. The retry therefore ran the whole
      // receipt again: a second GRN document, and the same twelve units counted
      // against the order twice, which is how a purchase order closes as
      // RECEIVED against goods nobody accepted.
      const { poId, poLineId } = await sentOrder(20);
      const key = `grn-rejected-${randomUUID()}`;
      const line = {
        poLineId,
        quantityReceived: "12.0000",
        qualityStatus: "REJECTED",
        rejectionReason: "Crushed in transit",
      };

      await receiveWithKey(poId, key, line);
      await receiveWithKey(poId, key, line);

      expect(await grnLinesFor(poLineId)).toHaveLength(1);
      expect(await receivedOnLine(poLineId)).toBe("12.0000");
    });

    it("replays an accepted receipt rather than refusing it", async () => {
      // The other half. Where movements did exist the retry was refused, and
      // only by accident: the engine hashes the command, the command carries
      // the new GRN's id, so an identical retry looked like a different request
      // and got 422. Right answer, wrong reason, wrong error — and it stopped
      // being right the moment a command stopped naming a fresh row.
      const { poId, poLineId } = await sentOrder(20);
      const key = `grn-accepted-${randomUUID()}`;
      const line = { poLineId, quantityReceived: "8.0000", qualityStatus: "ACCEPTED" };

      const first = await receiveWithKey(poId, key, line);
      const second = await receiveWithKey(poId, key, line);

      expect((second as { id: number }).id).toBe((first as { id: number }).id);
      expect(await grnLinesFor(poLineId)).toHaveLength(1);
      expect(await receivedOnLine(poLineId)).toBe("8.0000");

      // One movement, because the engine's own claim held; one document,
      // because the command's claim now holds too.
      const [ledger] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_stock_transactions
          WHERE org_id = ${scene.orgId} AND idempotency_key = ${`${key}:stock`}`),
      );
      expect(ledger!.n).toBe(1);
    });
  });

  describe("a terminal purchase order stops being expected", () => {
    const onOrder = async () => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ total: string }>(sql`
          SELECT COALESCE(SUM(COALESCE(on_order, 0)), 0)::text AS total
          FROM inv_stock_levels
          WHERE org_id = ${scene.orgId} AND product_variant_id = ${scene.variantId}`),
      );
      return Number(row!.total);
    };

    it("takes the outstanding quantity back out when the order is cancelled", async () => {
      // Sending books the goods as expected; nothing took them back out again
      // when the order was abandoned. Replenishment then read a permanent
      // phantom arrival and under-ordered that variant every cycle.
      const before = await onOrder();
      const { poId } = await sentOrder(30);
      expect(await onOrder()).toBe(before + 30);

      await asTenant(() =>
        app.app.get(PoService).cancelPo(scene.orgId, poId, scene.userId),
      );
      expect(await onOrder()).toBe(before);
    });

    it("takes the undelivered remainder back out when a partial order is closed", async () => {
      const before = await onOrder();
      const { poId, poLineId } = await sentOrder(20);
      await receive(poId, { poLineId, quantityReceived: "8.0000", qualityStatus: "ACCEPTED" });

      // 8 arrived, so 12 are still expected — until the buyer closes the order,
      // at which point nobody is ever going to deliver them.
      expect(await onOrder()).toBe(before + 12);

      await asTenant(() =>
        app.app.get(PoService).closePo(scene.orgId, poId, scene.userId),
      );
      expect(await onOrder()).toBe(before);
    });
  });

  /**
   * A5, item 3 — a receipt, and a return to the supplier, each announce
   * themselves.
   *
   * Receiving already emitted `inventory.purchase_order.received`, which is
   * keyed on the purchase order — so it answers "this order has had goods
   * against it" and cannot answer "this delivery arrived". A purchase order is
   * received many times, and a consumer reconciling one supplier advice note
   * had nothing to subscribe to. `inventory.receiving.posted` is the receipt
   * itself; the order-level event keeps its name, because something may already
   * be listening on it and a silently dead webhook is worse than a missing one.
   */
  describe("the events a receipt owes", () => {
    const eventsFor = (eventType: string, aggregateId?: string) =>
      asTenant(() =>
        outboxEventsFor(app.app.get<Db>(DRIZZLE), scene.orgId, eventType, aggregateId),
      );

    const receiveWithKey = (poId: number, key: string, line: Record<string, unknown>) =>
      asTenant(() =>
        app.app.get(GrnService).receiveGoods(scene.orgId, poId, scene.userId, key, {
          receivedDate: "2026-08-02",
          locationId: scene.locationId,
          lines: [line],
        } as never),
      );

    it("announces the receipt once, keyed on the delivery rather than the order", async () => {
      const { poId, poLineId } = await sentOrder(40);
      const key = `grn-event-${randomUUID()}`;
      const line = { poLineId, quantityReceived: "25.0000", qualityStatus: "ACCEPTED" };

      const grn = (await receiveWithKey(poId, key, line)) as { id: number };

      const events = await eventsFor(
        INVENTORY_COMMAND_EVENTS.RECEIVING_POSTED,
        String(grn.id),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.aggregateType).toBe("inv_grn");
      expect(events[0]!.payload.poId).toBe(poId);
      expect(events[0]!.payload.locationId).toBe(scene.locationId);
      expect(events[0]!.payload.warehouseId).toBe(scene.warehouseId);
      expect(events[0]!.payload.lineCount).toBe(1);
      expect(events[0]!.payload.acceptedLineCount).toBe(1);
      // 25 of 40, so the order is not closed by this delivery — the thing a
      // consumer chasing the supplier would otherwise re-read the order for.
      expect(events[0]!.payload.purchaseOrderStatus).toBe("PARTIAL");
      expect(events[0]!.payload.idempotencyKey).toBe(key);

      // Item 2: the order-level event that existed before this change is still
      // emitted. Renaming or dropping it would kill a webhook silently.
      const orderLevel = await eventsFor(
        "inventory.purchase_order.received",
        String(poId),
      );
      expect(orderLevel).toHaveLength(1);
      expect(orderLevel[0]!.payload.grnId).toBe(grn.id);

      // Both sit inside the receipt's claim, so a retry replays the stored GRN
      // id and neither fires again.
      await receiveWithKey(poId, key, line);
      expect(
        await eventsFor(INVENTORY_COMMAND_EVENTS.RECEIVING_POSTED, String(grn.id)),
      ).toHaveLength(1);
      expect(
        await eventsFor("inventory.purchase_order.received", String(poId)),
      ).toHaveLength(1);
    });

    it("announces a return to the vendor once, under the same event as a customer return", async () => {
      // Goods going back to a supplier and goods coming back from a customer
      // are one subscription — "stock left or arrived on a return" — so they
      // share an event type and are told apart by `returnType`.
      const { poId, poLineId } = await sentOrder(12);
      await receiveWithKey(poId, `grn-for-return-${randomUUID()}`, {
        poLineId,
        quantityReceived: "12.0000",
        qualityStatus: "ACCEPTED",
      });

      const returns = app.app.get(VendorReturnsService);
      const created = await asTenant(() =>
        returns.create(scene.orgId, scene.userId, {
          vendorId: scene.vendorId,
          poId,
          lines: [
            {
              productVariantId: scene.variantId,
              quantity: "3.0000",
              reason: "DAMAGED",
            },
          ],
        } as never),
      );
      const returnId = (created as { id: number }).id;

      // B9. The ledger moves on an approval, not on a draft.
      await asTenant(() =>
        returns.approve(scene.orgId, returnId, scene.userId, {}),
      );

      await asTenant(() =>
        returns.post(
          scene.orgId,
          returnId,
          scene.userId,
          `vret-${randomUUID().slice(0, 8)}`,
          {} as never,
        ),
      );

      const events = await eventsFor(
        INVENTORY_COMMAND_EVENTS.RETURN_POSTED,
        String(returnId),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.aggregateType).toBe("inv_vendor_return");
      expect(events[0]!.payload.returnType).toBe("VENDOR");
      expect(events[0]!.payload.vendorId).toBe(scene.vendorId);
      expect(events[0]!.payload.poId).toBe(poId);
      expect(events[0]!.payload.lineCount).toBe(1);

      // B9. A second post of a POSTED return short-circuits under the row lock,
      // announcing nothing.
      await asTenant(() =>
        returns.post(
          scene.orgId,
          returnId,
          scene.userId,
          `vret-again-${randomUUID().slice(0, 8)}`,
          {} as never,
        ),
      );
      expect(
        await eventsFor(INVENTORY_COMMAND_EVENTS.RETURN_POSTED, String(returnId)),
      ).toHaveLength(1);
    });
  });

  /**
   * B1 — a goods receipt has a life before it posts stock.
   *
   * `inv_grns` had no status column at all, so recording a delivery and posting
   * it to the ledger were one act: there was nowhere to put a pallet that had
   * arrived and not been counted, and no moment between "it is on the dock" and
   * "it is stock" in which anybody could look at it. These probes are the
   * difference: a draft that moves nothing, a post that moves everything at
   * once, and a retry that moves it once.
   */
  describe("a delivery counted before it is posted", () => {
    const grns = () => app.app.get(GrnService);

    const draftFor = (poId: number, lines: Array<Record<string, unknown>>, at = "2026-08-02") =>
      asTenant(() =>
        grns().createDraft(scene.orgId, scene.userId, `grn-draft-${randomUUID()}`, {
          poId,
          receivedDate: at,
          locationId: scene.locationId,
          lines,
        } as never),
      ) as Promise<{ id: number; status: string }>;

    const post = (grnId: number, key: string) =>
      asTenant(() => grns().postGrn(scene.orgId, grnId, scene.userId, key)) as Promise<{
        id: number;
        status: string;
      }>;

    const ledgerRows = async (variantId: number) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_stock_transactions
          WHERE org_id = ${scene.orgId} AND product_variant_id = ${variantId}`),
      );
      return row!.n;
    };

    const receivedOnLine = async (poLineId: number) => {
      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ quantity_received: string }>(sql`
          SELECT quantity_received FROM inv_po_lines
          WHERE org_id = ${scene.orgId} AND id = ${poLineId}`),
      );
      return row!.quantity_received;
    };

    it("leaves the ledger untouched until it posts, then moves stock once", async () => {
      const { poId, poLineId } = await sentOrder(60);
      const before = await ledgerRows(scene.variantId);

      const draft = await draftFor(poId, [
        { poLineId, quantityReceived: "25.0000", qualityStatus: "ACCEPTED" },
      ]);
      expect(draft.status).toBe("DRAFT");
      // The whole point: a recorded delivery that has moved nothing. The
      // purchase order has not been credited either — goods nobody has accepted
      // are still owed by the supplier.
      expect(await ledgerRows(scene.variantId)).toBe(before);
      expect(await receivedOnLine(poLineId)).toBe("0.0000");

      const counting = await asTenant(() =>
        grns().startCounting(scene.orgId, draft.id, scene.userId),
      );
      expect((counting as { status: string }).status).toBe("COUNTING");
      expect(await ledgerRows(scene.variantId)).toBe(before);

      const reviewing = await asTenant(() =>
        grns().submitForQualityReview(scene.orgId, draft.id, scene.userId),
      );
      expect((reviewing as { status: string }).status).toBe("QUALITY_REVIEW");
      expect(await ledgerRows(scene.variantId)).toBe(before);

      const key = `grn-post-${randomUUID()}`;
      const posted = await post(draft.id, key);
      expect(posted.status).toBe("POSTED");
      expect(posted.id).toBe(draft.id);
      expect(await ledgerRows(scene.variantId)).toBe(before + 1);
      expect(await receivedOnLine(poLineId)).toBe("25.0000");

      // The retry. One movement, one credited quantity, and the same document —
      // the claim spans the whole post, not the engine call inside it.
      const replayed = await post(draft.id, key);
      expect(replayed.id).toBe(draft.id);
      expect(await ledgerRows(scene.variantId)).toBe(before + 1);
      expect(await receivedOnLine(poLineId)).toBe("25.0000");
    });

    it("refuses a second post under a fresh key", async () => {
      // The idempotency claim answers a retry. It cannot answer a *different*
      // request that happens to post the same receipt, which is what a second
      // operator clicking Post looks like — that is the status predicate's job.
      const { poId, poLineId } = await sentOrder(20);
      const draft = await draftFor(poId, [
        { poLineId, quantityReceived: "20.0000", qualityStatus: "ACCEPTED" },
      ]);
      await post(draft.id, `grn-post-${randomUUID()}`);

      await expect(post(draft.id, `grn-post-${randomUUID()}`)).rejects.toThrow(
        ConflictException,
      );
      expect(await receivedOnLine(poLineId)).toBe("20.0000");
    });

    it("keeps a cancelled receipt out of the ledger for good", async () => {
      const { poId, poLineId } = await sentOrder(15);
      const before = await ledgerRows(scene.variantId);
      const draft = await draftFor(poId, [
        { poLineId, quantityReceived: "15.0000", qualityStatus: "ACCEPTED" },
      ]);

      const cancelled = await asTenant(() =>
        grns().cancelGrn(scene.orgId, draft.id, scene.userId, { reason: "Truck sent back" } as never),
      );
      expect((cancelled as { status: string }).status).toBe("CANCELLED");

      await expect(post(draft.id, `grn-post-${randomUUID()}`)).rejects.toThrow(
        BadRequestException,
      );
      expect(await ledgerRows(scene.variantId)).toBe(before);
      expect(await receivedOnLine(poLineId)).toBe("0.0000");
    });

    it("recounts an open receipt without touching stock", async () => {
      const { poId, poLineId } = await sentOrder(30);
      const before = await ledgerRows(scene.variantId);
      const draft = await draftFor(poId, [
        { poLineId, quantityReceived: "30.0000", qualityStatus: "ACCEPTED" },
      ]);

      // What actually came off the truck was 28, and the receiver says why.
      await asTenant(() =>
        grns().updateDraft(scene.orgId, draft.id, scene.userId, {
          lines: [
            {
              poLineId,
              quantityReceived: "28.0000",
              qualityStatus: "ACCEPTED",
              discrepancyReason: "SHORT",
            },
          ],
        } as never),
      );
      expect(await ledgerRows(scene.variantId)).toBe(before);

      await post(draft.id, `grn-post-${randomUUID()}`);
      const [grnLine] = await grnLinesFor(poLineId);
      expect(grnLine!.quantity_received).toBe("28.0000");
      expect(grnLine!.quantity_expected).toBe("30.0000");
      expect(grnLine!.discrepancy_reason).toBe("SHORT");
      expect(await ledgerRows(scene.variantId)).toBe(before + 1);
    });

    it("refuses to edit a receipt that has already posted", async () => {
      const { poId, poLineId } = await sentOrder(10);
      const draft = await draftFor(poId, [
        { poLineId, quantityReceived: "10.0000", qualityStatus: "ACCEPTED" },
      ]);
      await post(draft.id, `grn-post-${randomUUID()}`);

      await expect(
        asTenant(() =>
          grns().updateDraft(scene.orgId, draft.id, scene.userId, { notes: "too late" } as never),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("converts an entered quantity and keeps the factor on the line", async () => {
      // Two cases of twelve is twenty-four units in the ledger, and the line
      // remembers both halves — a later correction to the case size must not
      // rewrite what this receipt meant.
      const { poId, poLineId } = await sentOrder(24);
      const draft = await draftFor(poId, [
        {
          poLineId,
          quantityReceived: "2.0000",
          uomId: scene.caseUomId,
          qualityStatus: "ACCEPTED",
        },
      ]);
      await post(draft.id, `grn-post-${randomUUID()}`);

      const [row] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{
          quantity_received: string;
          quantity_entered: string;
          uom_factor: string;
        }>(sql`
          SELECT quantity_received, quantity_entered, uom_factor
          FROM inv_grn_lines WHERE org_id = ${scene.orgId} AND po_line_id = ${poLineId}`),
      );
      expect(row!.quantity_received).toBe("24.0000");
      expect(row!.quantity_entered).toBe("2.0000");
      expect(Number(row!.uom_factor)).toBe(12);
      expect(await receivedOnLine(poLineId)).toBe("24.0000");
    });

    it("refuses an expired batch at the door when the policy is BLOCK", async () => {
      // The allocator has always refused to ship an expired lot. Nothing
      // refused to receive one, so expired goods entered stock and were
      // permanently unsellable from the moment they arrived.
      const { poId, poLineId } = await sentOrder(5, scene.lotVariantId);
      const before = await ledgerRows(scene.lotVariantId);

      const draft = await draftFor(poId, [
        {
          poLineId,
          quantityReceived: "5.0000",
          qualityStatus: "ACCEPTED",
          lotNumber: `EXP-${randomUUID().slice(0, 6)}`,
          expiryDate: "2026-07-01",
        },
      ]);

      await expect(post(draft.id, `grn-post-${randomUUID()}`)).rejects.toThrow(
        BadRequestException,
      );
      expect(await ledgerRows(scene.lotVariantId)).toBe(before);
      // And the draft survives the refusal, so the receiver can correct the
      // expiry date they mistyped rather than starting the count again.
      const [grn] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ status: string }>(sql`
          SELECT status FROM inv_grns WHERE org_id = ${scene.orgId} AND id = ${draft.id}`),
      );
      expect(grn!.status).toBe("DRAFT");
    });

    it("accepts a batch that is still in date", async () => {
      // The control. Without it the refusal above would also pass against a
      // guard that blocked every lot it was ever shown.
      const { poId, poLineId } = await sentOrder(5, scene.lotVariantId);
      const before = await ledgerRows(scene.lotVariantId);
      const lotNumber = `OK-${randomUUID().slice(0, 6)}`;

      const draft = await draftFor(poId, [
        { poLineId, quantityReceived: "5.0000", qualityStatus: "ACCEPTED", lotNumber, expiryDate: "2027-01-01" },
      ]);
      await post(draft.id, `grn-post-${randomUUID()}`);

      expect(await ledgerRows(scene.lotVariantId)).toBe(before + 1);
      const [lot] = await asTenant(() =>
        app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM inv_lots
          WHERE org_id = ${scene.orgId} AND lot_number = ${lotNumber}`),
      );
      expect(lot!.n).toBe(1);
    });

    it("announces the receipt on the post and not on the draft", async () => {
      const { poId, poLineId } = await sentOrder(12);
      const draft = await draftFor(poId, [
        { poLineId, quantityReceived: "12.0000", qualityStatus: "ACCEPTED" },
      ]);

      const eventsFor = () =>
        asTenant(() =>
          outboxEventsFor(
            app.app.get<Db>(DRIZZLE),
            scene.orgId,
            INVENTORY_COMMAND_EVENTS.RECEIVING_POSTED,
            String(draft.id),
          ),
        );

      // A consumer told "received" by a draft would reconcile a supplier advice
      // note against goods still standing on the dock.
      expect(await eventsFor()).toHaveLength(0);

      await post(draft.id, `grn-post-${randomUUID()}`);
      const events = await eventsFor();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.purchaseOrderStatus).toBe("RECEIVED");
    });
  });
});
