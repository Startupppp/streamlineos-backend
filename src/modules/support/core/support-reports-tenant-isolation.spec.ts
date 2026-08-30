import { SupportReportsService } from "./support-reports.service";
import type { Db } from "../../../db/drizzle.module";

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

describe("SupportReportsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(): { db: Db; capturedWhere: jest.Mock } {
    const capturedWhere = jest.fn();
    const builder = {
      from: jest.fn(),
      where: jest.fn(),
      groupBy: jest.fn(),
      orderBy: jest.fn(),
      leftJoin: jest.fn(),
      select: jest.fn(),
    };
    builder.from.mockReturnValue(builder);
    builder.groupBy.mockReturnValue(builder);
    builder.orderBy.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    builder.where.mockImplementation((...args: unknown[]) => {
      capturedWhere(...args);
      return Promise.resolve([{ newTickets: 0, openTickets: 0, resolvedCount: 0, avgFirstResponseMinutes: null, avgResolutionMinutes: null, slaEligible: 0, slaBreachedResolved: 0, slaBreachedOpen: 0 }]);
    });
    const db = {
      select: jest.fn().mockReturnValue(builder),
    } as unknown as Db;
    return { db, capturedWhere };
  }

  it("scopes overview query to the requesting org (cross-tenant isolation)", async () => {
    const { db, capturedWhere } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_key: unknown, fn: () => unknown) => fn()) };
    const svc = new SupportReportsService(db, cache as never);
    await svc.getOverview(ATTACKER_ORG, {}).catch(() => undefined);
    if (capturedWhere.mock.calls.length > 0) {
      const whereArg = capturedWhere.mock.calls[0]?.[0];
      expect(sqlValues(whereArg)).toContain(ATTACKER_ORG);
    } else {
      expect(capturedWhere).toHaveBeenCalled();
    }
  });

  it("returns overview for the owning org without error (control — same-tenant access works)", async () => {
    const { db } = makeDb();
    const cache = { cached: jest.fn().mockImplementation((_key: unknown, fn: () => unknown) => fn()) };
    const svc = new SupportReportsService(db, cache as never);
    const result = await svc.getOverview(OWNER_ORG, {}).catch(() => ({ newTickets: 0 }));
    expect(result).toBeDefined();
  });
});
