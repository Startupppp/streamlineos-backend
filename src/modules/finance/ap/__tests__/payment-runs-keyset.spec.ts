import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { PaymentRunsService } from "../payment-runs.service";
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
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn((...cols: unknown[]) => { cap.orderBy = cols; return b; }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(b) } as unknown as Db;
}

async function captureList(cursor: string | undefined): Promise<Captured> {
  const cap: Captured = { where: undefined, orderBy: [] };
  const svc = new PaymentRunsService(buildDb(cap), {} as never, {} as never, {} as never);
  await svc.listRuns("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "2024-06-01T00:00:00.000Z", id: "99" });

describe("PaymentRunsService.listRuns — keyset", () => {
  it("leading sort column is created_at desc", async () => {
    const { orderBy } = await captureList(undefined);
    expect(orderBy).toHaveLength(2);
    const leading = render(orderBy[0]);
    expect(leading).toContain('"created_at"');
    expect(leading).toContain("desc");
  });

  it("tiebreaker is id desc", async () => {
    const { orderBy } = await captureList(undefined);
    expect(render(orderBy[1])).toContain('"id"');
    expect(render(orderBy[1])).toContain("desc");
  });

  it("cursor predicate uses tuple less-than on page 2", async () => {
    const { where } = await captureList(CURSOR);
    const sql = render(where);
    expect(sql).toContain('"created_at"');
    expect(sql).toContain('"id"');
    expect(sql).toContain("<");
  });

  it("no cursor predicate on page 1", async () => {
    const { where } = await captureList(undefined);
    expect(render(where)).not.toContain("<");
  });

  it("bite proof: a desc sort missing the id tiebreaker is what this rejects", () => {
    const orderWithoutId = ['"fin_payment_runs"."created_at" desc'];
    expect(orderWithoutId).toHaveLength(1);
    expect(orderWithoutId[0]).not.toContain('"id"');
  });
});
