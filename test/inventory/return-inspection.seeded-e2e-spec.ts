import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StockEngineService } from "src/modules/inventory/stock-engine/stock-engine.service";
import { CustomerReturnsService } from "src/modules/inventory/returns/customer-returns.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-209 — the returns disposition workflow.
 *
 * The disposition used to be declared when the return was created, which is
 * before anybody opened the box: a "faulty, please refund" note scrapped goods
 * nobody had confirmed were faulty, and a "wrong size" note restocked goods
 * nobody had looked at. The decision is now a separate act with an author and a
 * time, and posting waits for it.
 */
interface Scene {
  orgId: string;
  userId: string;
  variantId: number;
  locationId: number;
}

describe("[seeded-e2e] customer return inspection", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const returns = () => app.app.get(CustomerReturnsService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  async function draftReturn(withDisposition = false) {
    const created = await asTenant(() =>
      returns().create(scene.orgId, scene.userId, {
        lines: [
          {
            productVariantId: scene.variantId,
            quantity: "2.0000",
            targetLocationId: scene.locationId,
            ...(withDisposition ? { disposition: "RESTOCK" as const } : {}),
          },
        ],
      } as never),
    );
    const id = (created as { id: number }).id;
    const [line] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ id: number }>(sql`
        SELECT id FROM inv_customer_return_lines
        WHERE org_id = ${scene.orgId} AND return_id = ${id}`),
    );
    return { returnId: id, lineId: line!.id };
  }

  // B9. Approval is now the step between the inspection and the ledger, so the
  // walk-through is inspect -> approve -> post. `post` on a DRAFT return refuses
  // on the state machine before it ever reaches the inspection gate, which is
  // why the gate is exercised through `approve` below.
  const approve = (returnId: number) =>
    asTenant(() => returns().approve(scene.orgId, returnId, scene.userId, {}));

  const post = (returnId: number) =>
    asTenant(() =>
      returns().post(
        scene.orgId,
        returnId,
        scene.userId,
        `ret-${randomUUID()}`,
        {} as never,
      ),
    );

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
    const db = app.app.get<Db>(DRIZZLE);
    scene = await runInNewTenantTransaction(db, seeded.orgId, async () => {
      const userId = seeded.members["clerk"]!.userId;
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const uom = await one<{ id: number }>(sql`
        INSERT INTO inv_uom (org_id, name, abbreviation, is_base)
        VALUES (${seeded.orgId}, ${`Each ${tag}`}, ${`E${tag}`}, true) RETURNING id`);
      const product = await one<{ id: number }>(sql`
        INSERT INTO inv_products (org_id, uom_id, name, sku, created_by)
        VALUES (${seeded.orgId}, ${uom.id}, 'Returned goods', ${`RT-${tag}`}, ${userId})
        RETURNING id`);
      const variant = await one<{ id: number }>(sql`
        INSERT INTO inv_product_variants (org_id, product_id, name, sku)
        VALUES (${seeded.orgId}, ${product.id}, 'Default', ${`RT-${tag}-V`}) RETURNING id`);
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${seeded.orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const location = await one<{ id: number }>(sql`
        INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type)
        VALUES (${seeded.orgId}, ${warehouse.id}, 'Returns', ${`RB${tag}`}, 'BIN') RETURNING id`);
      return {
        orgId: seeded.orgId,
        userId,
        variantId: variant.id,
        locationId: location.id,
      };
    });

    await asTenant(() =>
      app.app.get(StockEngineService).execute(scene.orgId, scene.userId, {
        idempotencyKey: `ret-seed-${tag}`,
        sourceType: "return-fixture",
        sourceId: tag,
        movements: [
          {
            transactionType: "PURCHASE",
            productVariantId: scene.variantId,
            locationId: scene.locationId,
            quantityDelta: "50.0000",
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
    const { returnId } = await draftReturn();
    await expect(approve(returnId)).rejects.toThrow(BadRequestException);
    await expect(post(returnId)).rejects.toThrow(BadRequestException);
  });

  it("posts once every line has been inspected and the return is approved", async () => {
    // The control. Without it the refusal above would also pass against a
    // service that refused every return.
    const { returnId, lineId } = await draftReturn();
    await asTenant(() =>
      returns().inspectLine(scene.orgId, scene.userId, returnId, {
        lineId,
        disposition: "RESTOCK",
        inspectionNotes: "Unopened, resaleable",
      }),
    );
    await approve(returnId);
    await expect(post(returnId)).resolves.toBeDefined();
  });

  it("records who decided, and when", async () => {
    // Six months later, when it turns out the goods were not resaleable, this
    // is the only question worth asking.
    const { returnId, lineId } = await draftReturn();
    await asTenant(() =>
      returns().inspectLine(scene.orgId, scene.userId, returnId, {
        lineId,
        disposition: "SCRAP",
        inspectionNotes: "Cracked casing",
      }),
    );

    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{
        disposition: string;
        inspected_by: string;
        inspected_at: string;
        inspection_notes: string;
      }>(sql`
        SELECT disposition, inspected_by, inspected_at, inspection_notes
        FROM inv_customer_return_lines
        WHERE org_id = ${scene.orgId} AND id = ${lineId}`),
    );
    expect(row!.disposition).toBe("SCRAP");
    expect(row!.inspected_by).toBe(scene.userId);
    expect(row!.inspected_at).not.toBeNull();
    expect(row!.inspection_notes).toBe("Cracked casing");
  });

  it("refuses to approve a line whose disposition was merely asserted at intake", async () => {
    // The gate that matters. A disposition declared when the return was created
    // is a guess from the customer's description -- the exact thing that was
    // posting stock without anybody opening the box -- so it must not count as
    // an inspection.
    const { returnId } = await draftReturn(true);
    await expect(approve(returnId)).rejects.toThrow(BadRequestException);
    await expect(post(returnId)).rejects.toThrow(BadRequestException);
  });

  it("refuses to inspect a return that has already posted", async () => {
    // Changing a disposition the ledger has already acted on would leave the
    // record disagreeing with the stock.
    const { returnId, lineId } = await draftReturn(true);
    await asTenant(() =>
      returns().inspectLine(scene.orgId, scene.userId, returnId, {
        lineId,
        disposition: "RESTOCK",
      }),
    );
    await approve(returnId);
    await post(returnId);

    await expect(
      asTenant(() =>
        returns().inspectLine(scene.orgId, scene.userId, returnId, {
          lineId,
          disposition: "SCRAP",
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
