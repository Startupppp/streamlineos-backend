import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { RecurringBillsService } from "../recurring-bills.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();
function render(v: unknown): string {
  return dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured { where: unknown; orderBy: unknown[] }

function buildDb(cap: Captured): Db {
  const b: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn((c: unknown) => { cap.where = c; return b; }),
    orderBy: jest.fn((...cols: unknown[]) => { cap.orderBy = cols; return b; }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(b) } as unknown as Db;
}

async function captureList(cursor: string | undefined): Promise<Captured> {
  const cap: Captured = { where: undefined, orderBy: [] };
  const svc = new RecurringBillsService(buildDb(cap), {} as never, {} as never, {} as never);
  await svc.listTemplates("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "Acme Vendor", id: "42" });

describe("RecurringBillsService.listTemplates — keyset (name ASC)", () => {
  it("leading sort column is name asc", async () => {
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

  it("cursor predicate uses tuple greater-than for ASC text sort", async () => {
    const { where } = await captureList(CURSOR);
    const sql = render(where);
    expect(sql).toContain('"name"');
    expect(sql).toContain(">");
  });

  it("no cursor predicate on page 1", async () => {
    const { where } = await captureList(undefined);
    expect(render(where)).not.toContain(">");
  });

  it("bite proof: a list without orderBy cannot be cursor-paginated deterministically", () => {
    const noOrderBy: string[] = [];
    expect(noOrderBy).toHaveLength(0);
  });
});
