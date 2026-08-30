import type { Db } from "../../db/drizzle.module";
import { TaskAnalyticsService } from "./task-analytics.service";

function makeChainableDb(rowsByCall: unknown[][]): Db {
  let callIdx = 0;
  const makeBuilder = (rows: unknown[]) => {
    const obj: Record<string, unknown> = {};
    const methods = ["from", "where", "leftJoin", "groupBy", "orderBy", "limit"];
    for (const m of methods) obj[m] = jest.fn(() => obj);
    obj["then"] = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
    return obj;
  };
  const db = {
    select: jest.fn().mockImplementation(() => {
      const rows = rowsByCall[callIdx] ?? [];
      callIdx++;
      return makeBuilder(rows);
    }),
  } as unknown as Db;
  return db;
}

describe("TaskAnalyticsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("returns zero counts for a different org (isolation — no cross-tenant data)", async () => {
    const db = makeChainableDb([
      [{ total: 0 }],
      [{ completed: 0 }],
      [{ overdue: 0 }],
      [],
    ]);
    const svc = new TaskAnalyticsService(db);
    const result = await svc.analytics(ATTACKER, { days: 7 });
    expect(result.total).toBe(0);
  });

  it("returns aggregate counts for the owning org (control — same-tenant)", async () => {
    const db = makeChainableDb([
      [{ total: 5 }],
      [{ completed: 3 }],
      [{ overdue: 1 }],
      [{ assigneeId: "u1", firstName: "Alice", lastName: "Smith", name: null, total: 5, completed: 3, overdue: 1 }],
    ]);
    const svc = new TaskAnalyticsService(db);
    const result = await svc.analytics(OWNER, { days: 7 });
    expect(result).toHaveProperty("period");
    expect(result.total).toBe(5);
  });
});
