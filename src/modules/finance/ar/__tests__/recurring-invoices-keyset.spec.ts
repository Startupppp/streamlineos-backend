import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { RecurringInvoicesService } from "../recurring-invoices.service";
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
    query: { finRecurringInvoiceTemplates: { findFirst: jest.fn() } },
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };
  return { select: jest.fn().mockReturnValue(b), ...b } as unknown as Db;
}

async function captureList(cursor: string | undefined): Promise<Captured> {
  const cap: Captured = { where: undefined, orderBy: [] };
  const svc = new RecurringInvoicesService(buildDb(cap), {} as never, {} as never, {} as never);
  await svc.list("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "2024-05-01T00:00:00.000Z", id: "5" });

describe("RecurringInvoicesService.list — keyset", () => {
  it("sorts by created_at desc then id desc", async () => {
    const { orderBy } = await captureList(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"created_at"');
    expect(render(orderBy[0])).toContain("desc");
    expect(render(orderBy[1])).toContain('"id"');
  });

  it("cursor predicate uses strict less-than on page 2", async () => {
    const { where } = await captureList(CURSOR);
    expect(render(where)).toContain("<");
  });

  it("no cursor predicate on page 1", async () => {
    expect(render((await captureList(undefined)).where)).not.toContain("<");
  });
});
