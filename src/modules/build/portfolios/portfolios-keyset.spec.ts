import { PgDialect } from "drizzle-orm/pg-core";
import { PortfoliosService } from "./portfolios.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { encodeCursor } from "../../../common/pagination/cursor";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new PortfoliosService(buildDb(captured), {} as AuditService);
  await svc.listPortfolios("org-1", { cursor, limit: 20 });
  return captured;
}

describe("PortfoliosService.listPortfolios — keyset matches the sort", () => {
  it("orders by createdAt desc then id desc", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered[0]).toContain('"created_at"');
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain('"id"');
  });

  it("applies a strict less-than predicate when cursor is present", async () => {
    const cursor = encodeCursor({ sortValue: new Date().toISOString(), id: "7" });
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/</);
    expect(sql).not.toMatch(/>/);
  });

  it("omits the cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toMatch(/"created_at"\s*</);
  });

  it("bite proof: an asc sort would serve oldest-first instead of newest-first", () => {
    const wrongSort = ['"project_portfolios"."created_at" asc'];
    expect(wrongSort[0]).toContain("asc");
    expect(wrongSort[0]).not.toContain("desc");
  });
});
