import type { Db } from "../../db/drizzle.module";
import { CalendarProviderSyncSweepService } from "./calendar-provider-sync-sweep.service";

jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

describe("CalendarProviderSyncSweepService — cross-tenant isolation", () => {
  const ORG_A = "org-a";
  const ORG_B = "org-b";

  const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  function makeTx(captured: Array<{ orgId: string; where: unknown }>, txOrgId: string) {
    return {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((w: unknown) => {
            captured.push({ orgId: txOrgId, where: w });
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        }),
      }),
    };
  }

  it("embeds the correct org_id in the claim query and never touches a different org's rows (cross-tenant isolation)", async () => {
    const captured: Array<{ orgId: string; where: unknown }> = [];

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(makeTx(captured, ORG_A) as never, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 };
    });

    const db = { query: { calendarEvents: { findFirst: jest.fn().mockResolvedValue(null) } } } as unknown as Db;
    const sync = {} as never;
    const svc = new CalendarProviderSyncSweepService(db, sync);
    await svc.run();

    expect(captured).toHaveLength(1);
    const entry = captured[0];
    expect(entry).toBeDefined();
    const embedded = sqlValues(entry!.where);
    expect(embedded).toContain(ORG_A);
    expect(embedded).not.toContain(ORG_B);
  });

  it("does not claim or process rows for an org that forEachOrg does not yield", async () => {
    mockedForEachOrg.mockImplementation(async () => ({ organizations: 0, succeeded: 0, failed: 0 }));

    const db = {} as unknown as Db;
    const sync = {} as never;
    const svc = new CalendarProviderSyncSweepService(db, sync);
    const result = await svc.run();

    expect(result.claimed).toBe(0);
    expect(result.processed).toBe(0);
  });
});
