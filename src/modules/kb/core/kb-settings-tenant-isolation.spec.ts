import type { Db } from "../../../db/drizzle.module";
import { KbSettingsService } from "./kb-settings.service";

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

describe("KbSettingsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes settings lookup to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb(undefined);
    const svc = new KbSettingsService(db);

    await svc.getOrgSettings(ATTACKER_ORG);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns settings for the owning org (same-tenant control)", async () => {
    const { db } = makeDb({ orgId: OWNER_ORG, trashRetentionDays: 30 });
    const svc = new KbSettingsService(db);

    const result = await svc.getOrgSettings(OWNER_ORG);

    expect(result).toBeDefined();
    expect(result.trashRetentionDays).toBe(30);
  });
});
