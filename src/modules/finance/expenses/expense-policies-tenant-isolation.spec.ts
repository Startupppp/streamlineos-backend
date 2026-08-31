import type { Db } from "../../../db/drizzle.module";
import { ExpensePoliciesService } from "./expense-policies.service";

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

describe("ExpensePoliciesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeService(rows: unknown[]): { svc: ExpensePoliciesService; findMany: jest.Mock } {
    const findMany = jest.fn().mockResolvedValue(rows);
    const db = {
      query: { finExpensePolicies: { findMany } },
    } as unknown as Db;
    const cache = { cachedVersioned: jest.fn().mockImplementation((_ns: unknown, _k: unknown, fn: () => unknown) => fn()), invalidateForOrg: jest.fn() } as never;
    const svc = new ExpensePoliciesService(db, cache, {} as never);
    return { svc, findMany };
  }

  it("scopes findMany to the requesting org (tenant isolation)", async () => {
    const { svc, findMany } = makeService([]);

    await svc.list(ATTACKER_ORG);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(sqlValues(findMany.mock.calls[0]?.[0]?.where)).toContain(ATTACKER_ORG);
  });

  it("returns policies for the owning org (same-tenant control)", async () => {
    const { svc } = makeService([{ id: 1, orgId: OWNER_ORG }]);

    const result = await svc.list(OWNER_ORG);

    expect(result).toHaveLength(1);
  });
});
