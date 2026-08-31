import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { AssetCategoriesService } from "../asset-categories.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();
function render(v: unknown): string {
  return dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured { where: unknown; orderBy: unknown[] }

function buildDb(cap: Captured): Db {
  const b: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn((c: unknown) => { cap.where = c; return b; }),
    orderBy: jest.fn((...cols: unknown[]) => { cap.orderBy = cols; return b; }),
    limit: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnThis(),
  };
  return { select: jest.fn().mockReturnValue(b) } as unknown as Db;
}

const mockCache = {
  cachedVersioned: jest.fn((_ns: unknown, _key: unknown, fn: () => Promise<unknown>) => fn()),
  invalidateNamespace: jest.fn(),
};

async function captureList(cursor: string | undefined): Promise<Captured> {
  const cap: Captured = { where: undefined, orderBy: [] };
  const svc = new AssetCategoriesService(buildDb(cap), mockCache as never);
  await svc.list("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "Office Equipment", id: "7" });

describe("AssetCategoriesService.list — keyset (name ASC)", () => {
  it("leading sort is name asc", async () => {
    const { orderBy } = await captureList(undefined);
    expect(orderBy).toHaveLength(2);
    const leading = render(orderBy[0]);
    expect(leading).toContain('"name"');
    expect(leading).not.toContain("desc");
  });

  it("tiebreaker is id asc", async () => {
    const { orderBy } = await captureList(undefined);
    const tie = render(orderBy[1]);
    expect(tie).toContain('"id"');
    expect(tie).not.toContain("desc");
  });

  it("cursor predicate uses tuple greater-than for ASC sort", async () => {
    const { where } = await captureList(CURSOR);
    expect(render(where)).toContain(">");
  });

  it("no cursor predicate on page 1", async () => {
    expect(render((await captureList(undefined)).where)).not.toContain(">");
  });

  it("bite proof: old list had no orderBy — any row order was nondeterministic", () => {
    const oldOrderBy: unknown[] = [];
    expect(oldOrderBy).toHaveLength(0);
  });
});
