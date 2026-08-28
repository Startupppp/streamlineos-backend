import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { CarrierStatusService } from "src/modules/inventory/shipments/carrier-status.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-207 — the carrier status contract.
 *
 * Carrier webhooks are duplicated and out of order as a matter of course, so
 * those are the two probes that matter. A system that takes the latest message
 * as truth will regularly tell a customer their delivered parcel is back on a
 * van, and one without deduplication will record the same scan three times and
 * report a journey that never happened.
 */
interface Scene {
  orgId: string;
  userId: string;
  shipmentId: number;
  tracking: string;
  otherOrgTracking: string;
}

describe("[seeded-e2e] carrier status events", () => {
  let app: SeededE2eApp;
  let scene: Scene;
  const teardowns: Array<() => Promise<void>> = [];

  const svc = () => app.app.get(CarrierStatusService);
  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(app.app.get<Db>(DRIZZLE), scene.orgId, work);

  const post = (
    status: "LABEL_CREATED" | "SHIPPED" | "DELIVERED" | "CANCELLED",
    occurredAt: string,
    carrierEventId?: string,
    tracking?: string,
  ) =>
    asTenant(() =>
      svc().recordEvent(scene.orgId, scene.userId, {
        trackingNumber: tracking ?? scene.tracking,
        status,
        occurredAt,
        carrierEventId,
        rawPayload: { vendorSaid: status },
      }),
    );

  const shipmentStatus = async () => {
    const [row] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ status: string }>(sql`
        SELECT status FROM inv_shipments
        WHERE org_id = ${scene.orgId} AND id = ${scene.shipmentId}`),
    );
    return row!.status;
  };

  async function seedShipment(orgId: string, userId: string, tag: string) {
    const db = app.app.get<Db>(DRIZZLE);
    return runInNewTenantTransaction(db, orgId, async () => {
      const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
        (await db.execute<T>(q))[0]!;
      const warehouse = await one<{ id: number }>(sql`
        INSERT INTO inv_warehouses (org_id, name, code, created_by)
        VALUES (${orgId}, 'Main', ${`MN${tag}`}, ${userId}) RETURNING id`);
      const tracking = `TRK-${tag}`;
      const shipment = await one<{ id: number }>(sql`
        INSERT INTO inv_shipments
          (org_id, shipment_number, warehouse_id, tracking_number, status, created_by)
        VALUES (${orgId}, ${`SH-${tag}`}, ${warehouse.id}, ${tracking}, 'SHIPPED', ${userId})
        RETURNING id`);
      return { shipmentId: shipment.id, tracking };
    });
  }

  beforeAll(async () => {
    app = await createSeededE2eApp();
    const seeded = await seedOrg(app.seedDb)
      .onPlan("PAID")
      .addMember("dispatcher", { permissionKeys: ["inventory:shipments:manage"] })
      .build();
    teardowns.push(() => seeded.teardown());
    const tag = randomUUID().slice(0, 6);
    const mine = await seedShipment(
      seeded.orgId,
      seeded.members["dispatcher"]!.userId,
      tag,
    );

    // A neighbouring tenant's shipment, so "not yours" is a real tracking
    // number rather than one that exists nowhere.
    const other = await seedOrg(app.seedDb).onPlan("PAID").addMember("them").build();
    teardowns.push(() => other.teardown());
    const theirs = await seedShipment(
      other.orgId,
      other.members["them"]!.userId,
      `${tag}X`,
    );

    scene = {
      orgId: seeded.orgId,
      userId: seeded.members["dispatcher"]!.userId,
      shipmentId: mine.shipmentId,
      tracking: mine.tracking,
      otherOrgTracking: theirs.tracking,
    };
  }, 240_000);

  afterAll(async () => {
    for (const drop of teardowns) await drop().catch(() => undefined);
    await app.close();
  });

  it("advances a shipment when the carrier reports progress", async () => {
    // The control. Every refusal below is only meaningful because a genuine
    // advance does move the shipment.
    const result = await post("DELIVERED", "2026-08-28T10:00:00.000Z", "evt-1");
    expect(result).toMatchObject({ recorded: true, advanced: true, status: "DELIVERED" });
    expect(await shipmentStatus()).toBe("DELIVERED");
  });

  it("treats a replayed carrier event as a no-op", async () => {
    // The same event id arrives repeatedly in normal operation. Recording it
    // twice would report a journey that never happened.
    const result = await post("DELIVERED", "2026-08-28T10:00:00.000Z", "evt-1");
    expect(result.recorded).toBe(false);

    const [{ n }] = await asTenant(() =>
      app.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM inv_shipment_status_events
        WHERE org_id = ${scene.orgId} AND carrier_event_id = 'evt-1'`),
    );
    expect(n).toBe(1);
  });

  it("records a late out-of-order event without moving the shipment back", async () => {
    // An OUT_FOR_DELIVERY scan landing after DELIVERED is routine. The event is
    // worth keeping; acting on it would tell a customer their delivered parcel
    // is back on a van.
    const result = await post("SHIPPED", "2026-08-28T09:00:00.000Z", "evt-2");
    expect(result).toMatchObject({ recorded: true, advanced: false });
    expect(await shipmentStatus()).toBe("DELIVERED");

    const timeline = await asTenant(() =>
      svc().timeline(scene.orgId, scene.shipmentId),
    );
    // Still on the record, even though it changed nothing.
    expect(timeline.events.some((e) => e.status === "SHIPPED")).toBe(true);
  });

  it("keeps when it happened apart from when we heard", async () => {
    // A three-hour gap between these is the difference between a late parcel
    // and a late webhook, and only both columns can tell them apart.
    const timeline = await asTenant(() =>
      svc().timeline(scene.orgId, scene.shipmentId),
    );
    const event = timeline.events[0]!;
    expect(event.occurredAt).toBeDefined();
    expect(event.receivedAt).toBeDefined();
    expect(new Date(event.receivedAt).getTime()).toBeGreaterThan(
      new Date(event.occurredAt).getTime(),
    );
  });

  it("refuses a tracking number belonging to another tenant", async () => {
    // The carrier names a tracking number, never a shipment id, and it is
    // resolved inside the caller's tenant -- otherwise a webhook could address
    // any shipment in any organisation.
    await expect(
      post("DELIVERED", "2026-08-28T11:00:00.000Z", "evt-x", scene.otherOrgTracking),
    ).rejects.toThrow(NotFoundException);
  });
});
