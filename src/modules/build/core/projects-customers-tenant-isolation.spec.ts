import type { Db } from "../../../db/drizzle.module";
import { ProjectsCustomersService } from "./projects-customers.service";

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

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeDb(rows: unknown[], countVal = 0): Db {
  const where = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ offset: jest.fn().mockResolvedValue(rows) }) }),
    then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb([{ count: countVal }])),
  });
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({ where }),
      }),
    }),
  } as unknown as Db;
}

describe("ProjectsCustomersService — cross-tenant isolation", () => {
  it("list scopes WHERE to requesting org and returns no organizations for attacker (cross-tenant isolation)", async () => {
    const db = makeDb([], 0);
    const svc = new ProjectsCustomersService(db);

    const result = await svc.list(ATTACKER_ORG, { page: 1, limit: 10 });

    const whereArg = (db.select as jest.Mock).mock.results[0]?.value?.from.mock.results[0]?.value?.innerJoin.mock.results[0]?.value?.where;
    if (whereArg?.mock?.calls?.length) {
      const predicate = whereArg.mock.calls[0]?.[0];
      expect(sqlValues(predicate)).toContain(ATTACKER_ORG);
      expect(sqlValues(predicate)).not.toContain(OWNER_ORG);
    }
    expect(result.organizations).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it("list returns data for the owning org (control — same-tenant access works)", async () => {
    const fakeRow = { id: 1, name: "Acme", domain: null, industry: null, size: null, website: null, linkedinUrl: null, description: null, createdAt: new Date() };
    const db = makeDb([fakeRow], 1);
    const svc = new ProjectsCustomersService(db);

    const result = await svc.list(OWNER_ORG, { page: 1, limit: 10 });
    expect(result.organizations).toHaveLength(1);
  });
});
