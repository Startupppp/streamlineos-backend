// Covers: src/modules/notifications/notification-delivery-worker.service.ts
import type { Db } from "../../db/drizzle.module";
import { NotificationDeliveryWorker } from "./notification-delivery-worker.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("NotificationDeliveryWorker — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const DELIVERY_ID = 42;

  const config = {
    NOTIFICATIONS_INPROCESS_WORKER: "false",
    VAPID_PUBLIC_KEY: "",
  } as never;

  function makeDb(deliveryRow: unknown): Db {
    const findFirstCalls: unknown[][] = [];
    return {
      query: {
        notificationDeliveries: {
          findFirst: jest.fn().mockImplementation((opts: unknown) => {
            findFirstCalls.push([opts]);
            return Promise.resolve(deliveryRow);
          }),
        },
        notificationQueue: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;
  }

  it("returns false when the delivery belongs to a different org (BOLA isolation — cross-tenant deny)", async () => {
    const db = makeDb(undefined);
    const svc = new NotificationDeliveryWorker(db, {} as never, {} as never, config);

    const result = await svc.retryDelivery(ATTACKER, DELIVERY_ID);

    expect(result).toBe(false);
    const findFirstMock = db.query.notificationDeliveries.findFirst as jest.Mock;
    const whereArg = findFirstMock.mock.calls[0][0].where;
    const vals = sqlValues(whereArg);
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns true when the delivery belongs to the correct org (same-tenant control)", async () => {
    const db = makeDb({ id: DELIVERY_ID, orgId: OWNER, channel: "EMAIL", status: "FAILED" });
    const svc = new NotificationDeliveryWorker(db, {} as never, {} as never, config);

    const result = await svc.retryDelivery(OWNER, DELIVERY_ID);

    expect(result).toBe(true);
  });
});
