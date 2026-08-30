import type { Db } from "../../db/drizzle.module";
import { KbService } from "./kb.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChainableDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockResolvedValue(rows);
  const builder: Record<string, jest.Mock> = {
    from: jest.fn(),
    where,
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    offset: jest.fn().mockResolvedValue(rows),
  };
  builder.from.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.innerJoin.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.offset.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
  return { db, where };
}

describe("KbService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("returns empty list for a different org's KB (cross-tenant isolation)", async () => {
    const { db, where } = makeChainableDb([]);
    const svc = new KbService(db);
    const result = await svc.list({ org: ATTACKER, page: 1, pageSize: 10 });
    expect(result.articles).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER);
  });

  it("returns articles for the owning org (control — same-tenant)", async () => {
    const { db } = makeChainableDb([{ id: 1, title: "Article" }]);
    const svc = new KbService(db);
    const result = await svc.list({ org: OWNER, page: 1, pageSize: 10 });
    expect(result).toHaveProperty("articles");
  });
});
