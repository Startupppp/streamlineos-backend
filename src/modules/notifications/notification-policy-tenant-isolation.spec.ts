import type { Db } from "../../db/drizzle.module";
import { NotificationPolicyService } from "./notification-policy.service";

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

describe("NotificationPolicyService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; allWhereArgs: unknown[] } {
    const allWhereArgs: unknown[] = [];
    const findMany = jest.fn().mockImplementation(({ where } = {}) => {
      if (where) allWhereArgs.push(where);
      return Promise.resolve(rows);
    });
    const db = {
      query: { notificationPolicyDefaults: { findMany } },
    } as unknown as Db;
    return { db, allWhereArgs };
  }

  it("scopes policy list to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb([]);
    const cache = { del: jest.fn(), cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationPolicyService(db, cache);

    await svc.list(ATTACKER_ORG);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns policies for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER_ORG }]);
    const cache = { del: jest.fn(), cached: jest.fn().mockImplementation((_k: unknown, fn: () => unknown) => fn()) } as never;
    const svc = new NotificationPolicyService(db, cache);

    const result = await svc.list(OWNER_ORG);

    expect(result).toBeDefined();
  });
});
