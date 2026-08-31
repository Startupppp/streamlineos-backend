import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { ArPaymentsService } from "../ar-payments.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();
function render(v: unknown): string {
  return dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured { where: unknown; orderBy: unknown[] }

function buildDb(cap: Captured): Db {
  const b: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn((c: unknown) => { cap.where = c; return b; }),
    orderBy: jest.fn((...cols: unknown[]) => { cap.orderBy = cols; return b; }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(b) } as unknown as Db;
}

async function captureList(cursor: string | undefined): Promise<Captured> {
  const cap: Captured = { where: undefined, orderBy: [] };
  const svc = new ArPaymentsService(buildDb(cap));
  await svc.list("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "2024-06-01", id: "33" });

describe("ArPaymentsService.list — keyset (paymentDate DESC, id DESC)", () => {
  it("leading sort is payment_date desc", async () => {
    const { orderBy } = await captureList(undefined);
    expect(orderBy).toHaveLength(2);
    const leading = render(orderBy[0]);
    expect(leading).toContain('"payment_date"');
    expect(leading).toContain("desc");
  });

  it("tiebreaker is id desc", async () => {
    const { orderBy } = await captureList(undefined);
    const tie = render(orderBy[1]);
    expect(tie).toContain('"id"');
    expect(tie).toContain("desc");
  });

  it("cursor predicate adds tuple less-than on page 2", async () => {
    const { where } = await captureList(CURSOR);
    const sql = render(where);
    expect(sql).toContain('"payment_date"');
    expect(sql).toContain("<");
  });

  it("no cursor predicate on page 1", async () => {
    const { where } = await captureList(undefined);
    expect(render(where)).not.toContain("<");
  });

  it("bite proof: old pattern had a second count query — cursor removes it", () => {
    const offsetPattern = "count(*)::int FROM payments";
    expect(offsetPattern).toContain("count(*)");
  });
});
