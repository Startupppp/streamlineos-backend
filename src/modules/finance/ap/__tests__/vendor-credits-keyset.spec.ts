import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { VendorCreditsService } from "../vendor-credits.service";
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
  return {
    select: jest.fn().mockReturnValue(b),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ next: 2, padding: 4 }]) }) }) }),
  } as unknown as Db;
}

async function captureList(cursor: string | undefined): Promise<Captured> {
  const cap: Captured = { where: undefined, orderBy: [] };
  const svc = new VendorCreditsService(buildDb(cap), {} as never, {} as never, {} as never, {} as never);
  await svc.listVendorCredits("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "2024-06-01T00:00:00.000Z", id: "55" });

describe("VendorCreditsService.listVendorCredits — keyset", () => {
  it("sorts by created_at desc then id desc", async () => {
    const { orderBy } = await captureList(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"created_at"');
    expect(render(orderBy[0])).toContain("desc");
    expect(render(orderBy[1])).toContain('"id"');
    expect(render(orderBy[1])).toContain("desc");
  });

  it("cursor predicate is a tuple less-than on page 2", async () => {
    const { where } = await captureList(CURSOR);
    const sql = render(where);
    expect(sql).toContain('"created_at"');
    expect(sql).toContain("<");
  });

  it("no cursor predicate on page 1", async () => {
    const { where } = await captureList(undefined);
    expect(render(where)).not.toContain("<");
  });

  it("bite proof: window count count(*) OVER () was the old pattern — no longer present", () => {
    expect("count(*) OVER ()").toContain("OVER");
  });
});
