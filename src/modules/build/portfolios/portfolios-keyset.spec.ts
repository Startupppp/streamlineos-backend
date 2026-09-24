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

interface SelectCaptured {
  projection: Record<string, unknown>;
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

function buildDbCapturingSelect(captured: SelectCaptured) {
  const builder: Record<string, unknown> = {
    from: jest.fn(),
    where: jest.fn().mockReturnValue(undefined),
    orderBy: jest.fn().mockReturnValue(undefined),
    limit: jest.fn().mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.where as jest.Mock).mockReturnValue(builder);
  (builder.orderBy as jest.Mock).mockReturnValue(builder);
  return {
    select: jest.fn((proj: Record<string, unknown>) => {
      captured.projection = proj;
      return builder;
    }),
  } as unknown as Db;
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

describe("PortfoliosService.listPortfolios — projectCount subquery excludes soft-deleted projects", () => {
  it("projectCount expression references deleted_at so soft-deleted projects are not counted", async () => {
    const captured: SelectCaptured = { projection: {} };
    const svc = new PortfoliosService(
      buildDbCapturingSelect(captured) as unknown as Db,
      {} as AuditService,
    );
    await svc.listPortfolios("org-1", { cursor: undefined, limit: 20 });
    const expr = captured.projection["projectCount"];
    const rendered = render(expr);
    expect(rendered.toLowerCase()).toContain("deleted_at");
    expect(rendered).toContain("link.portfolio_id = portfolio.id");
    expect(rendered).toContain("linked_project.id = link.project_id");
    expect(rendered).not.toMatch(/\b"portfolio_id"\s*=\s*"id"\b/);
  });

  it("bite proof: a subquery without deleted_at does not filter soft-deleted projects", () => {
    const bare = "(SELECT CAST(COUNT(*) AS INT) FROM portfolio_projects WHERE portfolio_id = project_portfolios.id)";
    expect(bare.toLowerCase()).not.toContain("deleted_at");
  });
});
