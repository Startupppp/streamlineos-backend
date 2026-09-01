import { PayrollJobsService } from "../payroll-jobs.service";
import { decodeCursor } from "../../../../common/pagination/cursor";

function makeDb(rows: unknown[] = []) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, limit };
}

describe("PayrollJobsService — listFailed keyset pagination", () => {
  const orgId = "org-1";
  const t = new Date("2025-01-01T00:00:00.000Z");

  it("caps limit at 100 — requests cap+1 rows from DB", async () => {
    const { db, limit } = makeDb([]);
    const svc = new PayrollJobsService(db);
    await svc.listFailed(orgId, undefined, 200);
    expect(limit.mock.calls[0]?.[0]).toBeLessThanOrEqual(101);
  });

  it("returns first page when no cursor given", async () => {
    const row = { id: 5, orgId, status: "FAILED" as const, createdAt: t };
    const { db } = makeDb([row]);
    const svc = new PayrollJobsService(db);
    const page = await svc.listFailed(orgId, undefined, 10);
    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });

  it("sets nextCursor from the last kept row when DB returns limit+1 rows", async () => {
    const row1 = { id: 7, orgId, status: "FAILED" as const, createdAt: t };
    const row2 = { id: 5, orgId, status: "DEAD_LETTER" as const, createdAt: t };
    const { db } = makeDb([row1, row2]);
    const svc = new PayrollJobsService(db);
    const page = await svc.listFailed(orgId, undefined, 1);
    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(true);
    const pos = decodeCursor(page.pagination.nextCursor ?? undefined);
    expect(pos).not.toBeNull();
    expect(pos!.id).toBe("7");
    expect(new Date(pos!.sortValue).toISOString()).toBe(t.toISOString());
  });

  it("tie-breaking: two rows with same createdAt but different ids — cursor addresses the correct one", async () => {
    const rowA = { id: 7, orgId, status: "FAILED" as const, createdAt: t };
    const rowB = { id: 5, orgId, status: "DEAD_LETTER" as const, createdAt: t };

    const { db: db1 } = makeDb([rowA, rowB]);
    const svc1 = new PayrollJobsService(db1);
    const page1 = await svc1.listFailed(orgId, undefined, 1);
    expect(page1.data[0]).toEqual(rowA);

    const cursor = page1.pagination.nextCursor;
    expect(cursor).not.toBeNull();

    const pos = decodeCursor(cursor ?? undefined);
    expect(pos).not.toBeNull();
    expect(pos!.id).toBe("7");

    const { db: db2, limit: limit2 } = makeDb([rowB]);
    const svc2 = new PayrollJobsService(db2);
    const page2 = await svc2.listFailed(orgId, cursor!, 1);
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]).toEqual(rowB);
    expect(page2.pagination.hasMore).toBe(false);
    expect(limit2.mock.calls[0]?.[0]).toBe(2);
  });

  it("returns empty data with no nextCursor when DB returns no rows", async () => {
    const { db } = makeDb([]);
    const svc = new PayrollJobsService(db);
    const page = await svc.listFailed(orgId, undefined, 10);
    expect(page.data).toHaveLength(0);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination.nextCursor).toBeNull();
  });
});

describe("PayrollJobsService — listForResource keyset pagination", () => {
  const orgId = "org-1";
  const t = new Date("2025-06-01T00:00:00.000Z");

  it("caps limit at 100 — requests cap+1 rows from DB", async () => {
    const { db, limit } = makeDb([]);
    const svc = new PayrollJobsService(db);
    await svc.listForResource(orgId, "payroll_run", "1", undefined, 200);
    expect(limit.mock.calls[0]?.[0]).toBeLessThanOrEqual(101);
  });

  it("uses default limit=20 when none supplied — requests 21 rows", async () => {
    const { db, limit } = makeDb([]);
    const svc = new PayrollJobsService(db);
    await svc.listForResource(orgId, "payroll_run", "1", undefined);
    expect(limit.mock.calls[0]?.[0]).toBe(21);
  });

  it("tie-breaking: two rows with same createdAt but different ids — cursor advances past the first", async () => {
    const rowA = { id: 3, orgId, status: "SUCCEEDED" as const, createdAt: t };
    const rowB = { id: 7, orgId, status: "SUCCEEDED" as const, createdAt: t };

    const { db: db1 } = makeDb([rowA, rowB]);
    const svc1 = new PayrollJobsService(db1);
    const page1 = await svc1.listForResource(orgId, "payroll_run", "run-1", undefined, 1);
    expect(page1.data[0]).toEqual(rowA);

    const cursor = page1.pagination.nextCursor;
    expect(cursor).not.toBeNull();

    const pos = decodeCursor(cursor ?? undefined);
    expect(pos).not.toBeNull();
    expect(pos!.id).toBe("3");

    const { db: db2, limit: limit2 } = makeDb([rowB]);
    const svc2 = new PayrollJobsService(db2);
    const page2 = await svc2.listForResource(orgId, "payroll_run", "run-1", cursor!, 1);
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]).toEqual(rowB);
    expect(page2.pagination.hasMore).toBe(false);
    expect(limit2.mock.calls[0]?.[0]).toBe(2);
  });
});
