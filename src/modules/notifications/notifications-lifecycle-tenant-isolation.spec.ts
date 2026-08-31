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

  function makeDb(returnRows: unknown[] = []): { db: Db; capturedWhereArgs: unknown[] } {
    const capturedWhereArgs: unknown[] = [];
    const returning = jest.fn().mockResolvedValue(returnRows);
    const db = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            capturedWhereArgs.push(arg);
            return { returning };
          }),
        }),
      }),
    } as unknown as Db;
    return { db, capturedWhereArgs };
  }

  it("scopes update WHERE to the requesting org — attacker cannot touch owner data (BOLA isolation)", async () => {
    const { db, capturedWhereArgs } = makeDb([]);
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
    const notifEvents = { emit: jest.fn() } as never;
    const svc = new NotificationsLifecycleService(db, cache, notifEvents);

    await expect(svc.approve(ATTACKER_ORG, "user-1", 999)).rejects.toBeInstanceOf(NotFoundException);

    expect(capturedWhereArgs.length).toBeGreaterThan(0);
    const allVals = capturedWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
    expect(allVals).not.toContain(OWNER_ORG);
  });

  it("returns success for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1 }]);
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
    const notifEvents = { emit: jest.fn() } as never;
    const svc = new NotificationsLifecycleService(db, cache, notifEvents);

    const result = await svc.approve(OWNER_ORG, "user-1", 1);

    expect(result).toEqual({ success: true });
  });

  it("markRead on another user's notification returns 404, never 403 (cross-user ACK guard)", async () => {
    const { db } = makeDb([]);
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
    const notifEvents = { emit: jest.fn() } as never;
    const svc = new NotificationsLifecycleService(db, cache, notifEvents);

    await expect(
      svc.markRead("org-owner", "user-attacker", 42),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("markRead on own notification advances read state and returns success", async () => {
    const { db } = makeDb([{ id: 42 }]);
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
    const emitMock = jest.fn();
    const notifEvents = { emit: emitMock } as never;
    const svc = new NotificationsLifecycleService(db, cache, notifEvents);

    const result = await svc.markRead("org-owner", "user-owner", 42);

    expect(result).toEqual({ success: true });
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "count_changed" }),
    );
  });

  it("archive on another user's notification returns 404 (BOLA — cross-user archive)", async () => {
    const { db } = makeDb([]);
    const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
    const notifEvents = { emit: jest.fn() } as never;
    const svc = new NotificationsLifecycleService(db, cache, notifEvents);

    await expect(
      svc.archive("org-owner", "user-attacker", 99),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
