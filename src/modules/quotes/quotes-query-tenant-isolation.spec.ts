import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import { QuotesQueryService } from "./quotes-query.service";
import type { ListInput } from "./dto/quote.schemas";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];

  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

interface Harness {
  db: Db;
  cache: CacheService;
  where: jest.Mock;
  findFirst: jest.Mock;
  namespaces: string[];
}

function makeHarness(rows: unknown[] = []): Harness {
  const where = jest.fn();
  const builder: Record<string, unknown> & { then: (r: (v: unknown) => unknown) => unknown } = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where,
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve([{ count: rows.length }]).then(resolve),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  where.mockReturnValue(builder);

  const findFirst = jest.fn().mockResolvedValue(undefined);
  const db = {
    select: jest.fn().mockReturnValue(builder),
    query: { quotes: { findFirst } },
  } as unknown as Db;

  const namespaces: string[] = [];
  const cache = {
    cachedVersioned: jest.fn(
      async (namespace: string, _key: string, fetcher: () => Promise<unknown>) => {
        namespaces.push(namespace);
        return fetcher();
      },
    ),
  } as unknown as CacheService;

  return { db, cache, where, findFirst, namespaces };
}

function listInput(overrides: Partial<ListInput> = {}): ListInput {
  return { pageSize: 20, ...overrides } as ListInput;
}

/**
 * quotes-query.service.ts was split out by a076c5e1a and its cross-tenant
 * coverage did not follow it. This service is one of the few that can leak two
 * different ways, so both are asserted: the SQL predicate, and the cache
 * namespace. A correct predicate cached under a namespace that omits the org
 * serves the first caller's rows to the next one and defeats the predicate in
 * both directions.
 */
describe("QuotesQueryService — cross-tenant isolation", () => {
  it("list binds the requesting org into the predicate and never the other org", async () => {
    const { db, cache, where } = makeHarness();
    const svc = new QuotesQueryService(db, cache);

    await svc.list(ATTACKER_ORG, listInput());

    const bound = where.mock.calls.flatMap((call) => sqlValues(call[0]));
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).not.toContain(OWNER_ORG);
  });

  it("list namespaces its cache by org, so one tenant's page can never be served to another", async () => {
    const attacker = makeHarness();
    const owner = makeHarness();

    await new QuotesQueryService(attacker.db, attacker.cache).list(ATTACKER_ORG, listInput());
    await new QuotesQueryService(owner.db, owner.cache).list(OWNER_ORG, listInput());

    expect(attacker.namespaces).toEqual([`quotes:list:${ATTACKER_ORG}`]);
    expect(owner.namespaces).toEqual([`quotes:list:${OWNER_ORG}`]);
    expect(attacker.namespaces[0]).not.toBe(owner.namespaces[0]);
  });

  it("list keeps the org predicate when a filter and a search term narrow the query further", async () => {
    const { db, cache, where } = makeHarness();
    const svc = new QuotesQueryService(db, cache);

    await svc.list(ATTACKER_ORG, listInput({ status: "SENT", search: "renewal" }));

    const bound = where.mock.calls.flatMap((call) => sqlValues(call[0]));
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).toContain("%renewal%");
    expect(bound).not.toContain(OWNER_ORG);
  });

  it("getQuote scopes to the requesting org, so another org's quote id resolves to nothing", async () => {
    const { db, cache, findFirst } = makeHarness();
    const svc = new QuotesQueryService(db, cache);

    const result = await svc.getQuote(ATTACKER_ORG, 4242);

    expect(result).toBeUndefined();
    const bound = sqlValues(findFirst.mock.calls[0]?.[0]?.where);
    expect(bound).toContain(ATTACKER_ORG);
    expect(bound).toContain(4242);
    expect(bound).not.toContain(OWNER_ORG);
  });

  it("getQuote binds the owner org on the control path (same tenant reads its own quote)", async () => {
    const { db, cache, findFirst } = makeHarness();
    findFirst.mockResolvedValue({ id: 7, orgId: OWNER_ORG });
    const svc = new QuotesQueryService(db, cache);

    const result = await svc.getQuote(OWNER_ORG, 7);

    expect(result).toEqual({ id: 7, orgId: OWNER_ORG });
    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toContain(OWNER_ORG);
  });
});
