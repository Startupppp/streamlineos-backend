import { PgDialect } from "drizzle-orm/pg-core";
import { AccountingPayablesQueryService } from "../accounting-payables-query.service";
import { encodeCursor } from "../../../../common/pagination/cursor";
import type { Db } from "../../../../db/drizzle.module";

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
    leftJoin: jest.fn(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return builder;
    }),
    groupBy: jest.fn(),
    $dynamic: jest.fn(),
    having: jest.fn(),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return builder;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };
  (builder.from as jest.Mock).mockReturnValue(builder);
  (builder.leftJoin as jest.Mock).mockReturnValue(builder);
  (builder.groupBy as jest.Mock).mockReturnValue(builder);
  (builder.$dynamic as jest.Mock).mockReturnValue(builder);
  (builder.having as jest.Mock).mockReturnValue(builder);
  return { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
}

async function capture(cursor: string | undefined): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new AccountingPayablesQueryService(buildDb(captured));
  await svc.listVendors("org-a", { cursor, limit: 20 });
  return captured;
}

describe("AccountingPayablesQueryService.listVendors — keyset matches sort", () => {
  it("orders by name as the leading sort column", async () => {
    const { orderBy } = await capture(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"name"');
  });

  it("id is the tiebreaker sort column", async () => {
    const { orderBy } = await capture(undefined);
    expect(render(orderBy[1])).toContain('"id"');
  });

  it("advances cursor with strict > inequality", async () => {
    const cursor = encodeCursor({ sortValue: "Acme Corp", id: "5" });
    const { where } = await capture(cursor);
    const sql = render(where);
    expect(sql).toMatch(/"name"[\s\S]*>[\s\S]*\$\d+/);
    expect(sql).not.toMatch(/"name"[\s\S]*=[\s\S]*/);
  });

  it("omits cursor predicate on the first page", async () => {
    const { where } = await capture(undefined);
    expect(render(where)).not.toMatch(/>\s*\$\d+/);
  });

  it("bite proof: wrong leading sort column is detected", async () => {
    const { orderBy } = await capture(undefined);
    expect(render(orderBy[0])).not.toContain('"org_id"');
  });
});
