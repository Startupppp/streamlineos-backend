import type { Db } from "../../../db/drizzle.module";
import { KbCreditsService } from "./kb-credits.service";

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

function makeDb(row?: unknown): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    query: new Proxy({}, {
      get: () => ({
        findFirst: jest.fn().mockImplementation(({ where }: { where?: unknown } = {}) => {
          if (where) allWhereArgs.push(where);
          return Promise.resolve(row);
        }),
      }),
    }),
  } as unknown as Db;
  return { db, allWhereArgs };
}

describe("KbCreditsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes AI credit balance lookup to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb(undefined);
    const svc = new KbCreditsService(db);

    await svc.getBalance(ATTACKER_ORG);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns credit balance for the owning org (same-tenant control)", async () => {
    const { db } = makeDb({ orgId: OWNER_ORG, balance: 1000, reservedBalance: 0 });
    const svc = new KbCreditsService(db);

    const result = await svc.getBalance(OWNER_ORG);

    expect(result).toBeDefined();
  });
});
