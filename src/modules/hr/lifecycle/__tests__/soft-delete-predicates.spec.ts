import type { Db } from "../../../../db/drizzle.module";
import { HrDashboardReportsService } from "../hr-dashboard-reports.service";
import type { CacheService } from "../../../../common/cache/cache.service";

function makeCallthrough(): CacheService {
  return {
    cached: jest.fn((_key: string, fetcher: () => Promise<unknown>) => fetcher()),
  } as unknown as CacheService;
}

describe("HrDashboardReportsService.timeToFill — org-scoped dept name lookup", () => {
  const ORG = "org-1";
  const DEPT_ID = "dept-deleted";

  it("uses fallback label when deleted dept is excluded (DB returns no dept row for the id)", async () => {
    let callCount = 0;
    const select = jest.fn().mockImplementation(() => {
      callCount++;
      const rows =
        callCount === 1
          ? [{ orgDepartmentId: DEPT_ID, createdAt: new Date("2024-01-01"), updatedAt: new Date("2024-02-01") }]
          : [];
      const chain: Record<string, unknown> = {
        from: jest.fn(),
        where: jest.fn(),
        limit: jest.fn(),
        orderBy: jest.fn(),
        leftJoin: jest.fn(),
        innerJoin: jest.fn(),
      };
      for (const k of ["from", "where", "limit", "orderBy", "leftJoin", "innerJoin"])
        (chain[k] as jest.Mock).mockReturnValue(chain);
      (chain["limit"] as jest.Mock).mockResolvedValue(rows);
      (chain["where"] as jest.Mock).mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) });
      return chain;
    });

    const db = { select } as unknown as Db;
    const svc = new HrDashboardReportsService(db, makeCallthrough());

    const result = await svc.timeToFill(ORG);
    expect(result).toBeTruthy();
    const byDept = (result as { byDepartment: { department: string }[] }).byDepartment;
    const deptEntry = byDept.find((d) => d.department.includes(DEPT_ID) || d.department.startsWith("Dept "));
    expect(deptEntry).toBeDefined();
  });
});
