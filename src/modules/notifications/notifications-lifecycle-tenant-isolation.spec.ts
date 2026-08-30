import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { NotificationsLifecycleService } from "./notifications-lifecycle.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("NotificationsLifecycleService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("throws NotFoundException when notification belongs to a different org (BOLA isolation)", async () => {
    const db = {
      transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
        })
      ),
    } as unknown as Db;
    const cache = { del: jest.fn() } as never;
    const notifEvents = { emit: jest.fn() } as never;
    const svc = new NotificationsLifecycleService(db, cache, notifEvents);

    await expect(svc.approve(ATTACKER_ORG, "user-1", 999)).rejects.toThrow(NotFoundException);
  });

  it("does not throw for the owning org's notification (same-tenant control)", async () => {
    const notif = { id: 1, orgId: OWNER_ORG, actionPayload: { approvalRoute: "test" } };
    const db = {
      transaction: jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([notif]) }) }) }),
          update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
        })
      ),
    } as unknown as Db;
    const cache = { del: jest.fn() } as never;
    const notifEvents = { emit: jest.fn() } as never;
    const svc = new NotificationsLifecycleService(db, cache, notifEvents);

    const err = await svc.approve(OWNER_ORG, "user-1", 1).catch(e => e);

    expect(err).not.toBeInstanceOf(NotFoundException);
  });
});
