import type { Db } from "../../../db/drizzle.module";
import { KbPageTemplatesService } from "./kb-page-templates.service";

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

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    offset: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

function makeDb(rows: unknown[] = []): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeChain(rows);
        }),
      }),
    })),
  } as unknown as Db;
  return { db, allWhereArgs };
}

describe("KbPageTemplatesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes template list to the requesting org (tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb([]);
    const svc = new KbPageTemplatesService(db);

    await svc.list(ATTACKER_ORG);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns templates for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER_ORG, name: "Blank" }]);
    const svc = new KbPageTemplatesService(db);

    const result = await svc.list(OWNER_ORG);

    expect(result).toHaveLength(1);
  });
});
