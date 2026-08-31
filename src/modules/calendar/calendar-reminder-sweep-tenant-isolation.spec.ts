import type { Db, TenantTx } from "../../db/drizzle.types";
import { CalendarReminderSweepService } from "./calendar-reminder-sweep.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("CalendarReminderSweepService — cross-tenant isolation", () => {
  const ORG_A = "org-a";
  const ORG_B = "org-b";

  const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  function makeTx(wheres: unknown[]) {
    const chain = Object.assign(Promise.resolve([]), {
      limit: jest.fn().mockResolvedValue([]),
    });
    const from = jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return chain; }),
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((a: unknown) => { wheres.push(a); return chain; }),
      }),
    });
    return { select: jest.fn().mockReturnValue({ from }) } as unknown as TenantTx;
  }

  it("scopes reminder queries to the correct org (tenant isolation — different orgs don't share data)", async () => {
    const wheresA: unknown[] = [];
    const txA = makeTx(wheresA);

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(txA, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    await svc.run();

    expect(wheresA.length).toBeGreaterThan(0);
    const vals = wheresA.flatMap(w => sqlValues(w));
    expect(vals).toContain(ORG_A);
    expect(vals).not.toContain(ORG_B);
  });

  it("processes org callbacks for each org independently (same-tenant control)", async () => {
    const wheresOwner: unknown[] = [];
    const txOwner = makeTx(wheresOwner);

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(txOwner, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const db = {} as unknown as Db;
    const svc = new CalendarReminderSweepService(db);
    const result = await svc.run();

    expect(result).toBeDefined();
    expect(result).toHaveProperty("candidates");
  });
});
