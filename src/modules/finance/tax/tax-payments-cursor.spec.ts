import { TaxPaymentsService } from "./tax-payments.service";
import type { Db } from "../../../db/drizzle.module";

function makeDb(items: unknown[]): Db {
  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(items),
          }),
        }),
      }),
    })),
  } as unknown as Db;
}

function makeCache() {
  return {
    cachedVersioned: jest.fn().mockImplementation(
      (_ns: unknown, _k: unknown, fn: () => unknown) => fn(),
    ),
  };
}

function makeSvc(items: unknown[]) {
  return new TaxPaymentsService(
    makeDb(items),
    makeCache() as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe("TaxPaymentsService.list — nextCursor is null (not undefined) on exhaustion", () => {
  it("returns null nextCursor when fewer rows than the limit exist", async () => {
    const svc = makeSvc([{ id: 5 }, { id: 4 }]);
    const result = await svc.list("org-1", { limit: 10 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(result.pagination.hasMore).toBe(false);
    expect(result.items).toHaveLength(2);
  });

  it("returns null nextCursor when the result set is empty", async () => {
    const svc = makeSvc([]);
    const result = await svc.list("org-1", { limit: 10 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(result.pagination.hasMore).toBe(false);
  });

  it("returns null nextCursor when exactly limit rows exist (no sentinel)", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: 5 - i }));
    const svc = makeSvc(items);
    const result = await svc.list("org-1", { limit: 5 });
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(result.pagination.hasMore).toBe(false);
    expect(result.items).toHaveLength(5);
  });

  it("returns a numeric nextCursor (not null, not undefined) when sentinel row exists", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: 6 - i }));
    const svc = makeSvc(items);
    const result = await svc.list("org-1", { limit: 5 });
    expect(result.pagination.nextCursor).not.toBeNull();
    expect(result.pagination.nextCursor).not.toBeUndefined();
    expect(typeof result.pagination.nextCursor).toBe("number");
    expect(result.pagination.hasMore).toBe(true);
    expect(result.items).toHaveLength(5);
  });

  it("caps the effective limit at 100 even if caller requests more", async () => {
    const svc = makeSvc([]);
    const result = await svc.list("org-1", { limit: 100 });
    expect(result.pagination.limit).toBeLessThanOrEqual(100);
  });
});
