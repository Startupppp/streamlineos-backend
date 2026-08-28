import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { CartonizationService } from "src/modules/inventory/shipments/cartonization.service";
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
}

describe("[seeded-e2e] cartonization", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  let teardown: () => Promise<void>;

  const carton = () => app.app.get(CartonizationService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("packer", { permissionKeys: ["inventory:shipments:manage"] })
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
      };
    });
  }, 240_000);

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
});
