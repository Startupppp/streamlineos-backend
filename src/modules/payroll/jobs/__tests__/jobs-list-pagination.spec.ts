import { PayrollJobsService } from "../payroll-jobs.service";

function makeDbForList(rows: unknown[] = []) {
  const offset = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ offset });
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, limit };
}

function makeDbForResource(rows: unknown[] = []) {
  const offset = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ offset });
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, limit };
}

describe("PayrollJobsService — pagination cap", () => {
  const orgId = "org-1";

  describe("listFailed", () => {
    it("caps at 100 when caller requests more", async () => {
      const { db, limit } = makeDbForList();
      const svc = new PayrollJobsService(db);
      await svc.listFailed(orgId, 1, 200);
      expect(limit.mock.calls[0]?.[0]).toBeLessThanOrEqual(100);
    });

    it("uses default limit=50 when none supplied", async () => {
      const { db, limit } = makeDbForList();
      const svc = new PayrollJobsService(db);
      await svc.listFailed(orgId);
      expect(limit.mock.calls[0]?.[0]).toBe(50);
    });
  });

  describe("listForResource", () => {
    it("caps at 100 when caller requests more", async () => {
      const { db, limit } = makeDbForResource();
      const svc = new PayrollJobsService(db);
      await svc.listForResource(orgId, "payroll_run", "1", 1, 200);
      expect(limit.mock.calls[0]?.[0]).toBeLessThanOrEqual(100);
    });

    it("uses default limit=20 when none supplied", async () => {
      const { db, limit } = makeDbForResource();
      const svc = new PayrollJobsService(db);
      await svc.listForResource(orgId, "payroll_run", "1");
      expect(limit.mock.calls[0]?.[0]).toBe(20);
    });
  });
});
