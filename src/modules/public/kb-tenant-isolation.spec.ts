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

interface Chain extends PromiseLike<unknown[]> {
  from: jest.Mock;
  where: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
}

function makeChain(rows: unknown[]): Chain {
  const chain = {} as Chain;
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.offset = jest.fn().mockResolvedValue(rows);
  chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve ?? undefined, reject ?? undefined);
  return chain;
}

describe("KbService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  it("returns empty list for a different org's KB (cross-tenant isolation)", async () => {
    let selectCallCount = 0;
    const categoriesChain = makeChain([]);
    const articlesChain = makeChain([]);

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? categoriesChain : articlesChain;
      }),
    } as unknown as Db;

    const svc = new KbService(db);
    const result = await svc.list({ org: ATTACKER, pageSize: 10 });

    expect(result.articles).toHaveLength(0);
    expect(categoriesChain.where).toHaveBeenCalled();
    const allVals = sqlValues(categoriesChain.where.mock.calls[0]?.[0]);
    expect(allVals).toContain(ATTACKER);
  });

  it("returns articles for the owning org (control — same-tenant)", async () => {
    let selectCallCount = 0;
    const categoriesChain = makeChain([]);
    const articlesChain = makeChain([{ id: 1, title: "Article" }]);

    const db = {
      select: jest.fn().mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? categoriesChain : articlesChain;
      }),
    } as unknown as Db;

    const svc = new KbService(db);
    const result = await svc.list({ org: OWNER, pageSize: 10 });

    expect(result).toHaveProperty("articles");
  });
});
