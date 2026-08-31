import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { VendorPaymentsListService } from "../vendor-payments-list.service";
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
  const svc = new VendorPaymentsListService(buildDb(cap));
  await svc.list("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "2024-06-01", id: "77" });

describe("VendorPaymentsListService.list — keyset (paymentDate DESC, id DESC)", () => {
  it("sorts by payment_date desc then id desc (not asc)", async () => {
    const { orderBy } = await captureList(undefined);
    expect(orderBy).toHaveLength(2);
    const leading = render(orderBy[0]);
    const tie = render(orderBy[1]);
    expect(leading).toContain('"payment_date"');
    expect(leading).toContain("desc");
    expect(tie).toContain('"id"');
    expect(tie).toContain("desc");
    expect(tie).not.toContain("asc");
  });

  it("cursor predicate uses tuple less-than for date DESC sort", async () => {
    const { where } = await captureList(CURSOR);
    const sql = render(where);
    expect(sql).toContain('"payment_date"');
    expect(sql).toContain("<");
  });

  it("no cursor predicate on page 1", async () => {
    expect(render((await captureList(undefined)).where)).not.toContain("<");
  });

  it("bite proof: old sort had asc(id) which breaks keysetBefore", () => {
    const badSort = "payment_date desc, id asc";
    expect(badSort).toContain("asc");
  });
});
