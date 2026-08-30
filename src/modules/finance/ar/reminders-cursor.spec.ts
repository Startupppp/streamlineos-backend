import { RemindersService } from "./reminders.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

function makeSelectChain(items: unknown[]): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {};
  for (const m of ["from", "where", "orderBy"]) {
    chain[m] = jest.fn().mockReturnValue(chain);
  }
  chain["limit"] = jest.fn().mockResolvedValue(items);
  return chain;
}

function makeSvc(items: unknown[]) {
  const chain = makeSelectChain(items);
  const db = {
    select: jest.fn().mockReturnValue(chain),
    query: { finReminderPolicies: { findFirst: jest.fn() } },
    update: jest.fn(),
  } as unknown as Db;
  const audit = { log: jest.fn() } as unknown as AuditService;
  return new RemindersService(db, audit);
}

describe("RemindersService.listPolicies — nextCursor is null (not undefined) on exhaustion", () => {
  it("returns null nextCursor when fewer rows than the limit exist", async () => {
    const svc = makeSvc([{ id: 1 }, { id: 2 }]);
    const result = await svc.listPolicies("org-1", { limit: 10 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(result.pagination.hasMore).toBe(false);
    expect(result.items).toHaveLength(2);
  });

  it("returns null nextCursor when the result set is empty", async () => {
    const svc = makeSvc([]);
    const result = await svc.listPolicies("org-1", { limit: 10 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
  });

  it("returns null nextCursor when exactly limit rows exist (no sentinel)", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const svc = makeSvc(items);
    const result = await svc.listPolicies("org-1", { limit: 5 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(result.items).toHaveLength(5);
  });

  it("returns a numeric nextCursor when sentinel row exists", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    const svc = makeSvc(items);
    const result = await svc.listPolicies("org-1", { limit: 5 });
    expect(result.pagination.nextCursor).not.toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(typeof result.pagination.nextCursor).toBe("number");
    expect(result.pagination.hasMore).toBe(true);
    expect(result.items).toHaveLength(5);
  });
});

describe("RemindersService.listLog — nextCursor is null (not undefined) on exhaustion", () => {
  it("returns null nextCursor when fewer rows than the limit exist", async () => {
    const svc = makeSvc([{ id: 1 }, { id: 2 }]);
    const result = await svc.listLog("org-1", { limit: 10 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(result.pagination.hasMore).toBe(false);
  });

  it("returns null nextCursor when the result set is empty", async () => {
    const svc = makeSvc([]);
    const result = await svc.listLog("org-1", { limit: 10 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
  });

  it("returns a numeric nextCursor when sentinel row exists", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }));
    const svc = makeSvc(items);
    const result = await svc.listLog("org-1", { limit: 5 });
    expect(result.pagination.nextCursor).not.toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(typeof result.pagination.nextCursor).toBe("number");
    expect(result.pagination.hasMore).toBe(true);
    expect(result.items).toHaveLength(5);
  });
});
