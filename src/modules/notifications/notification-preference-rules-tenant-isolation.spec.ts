import type { Db } from "../../db/drizzle.module";
import { NotificationPreferenceRulesService } from "./notification-preference-rules.service";

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

describe("NotificationPreferenceRulesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; allWhereArgs: unknown[] } {
    const allWhereArgs: unknown[] = [];
    const where = jest.fn().mockImplementation((arg: unknown) => {
      allWhereArgs.push(arg);
      return Object.assign(Promise.resolve(rows), {
        limit: jest.fn().mockResolvedValue(rows),
      });
    });
    const db = { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }) } as unknown as Db;
    return { db, allWhereArgs };
  }

  it("scopes preference rule list to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb([]);
    const svc = new NotificationPreferenceRulesService(db);

    await svc.list(ATTACKER_ORG, "user-1", 7);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns rules only for the requesting org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER_ORG }]);
    const svc = new NotificationPreferenceRulesService(db);

    const result = await svc.list(OWNER_ORG, "user-1", 7);

    expect(result).toHaveLength(1);
  });
});
