import { PgDialect } from "drizzle-orm/pg-core";
import { encodeCursor } from "../../../../common/pagination/cursor";
import { CollectionsService } from "../collections.service";
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
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn((...cols: unknown[]) => { cap.orderBy = cols; return b; }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(b) } as unknown as Db;
}

async function captureList(cursor: string | undefined): Promise<Captured> {
  const cap: Captured = { where: undefined, orderBy: [] };
  const svc = new CollectionsService(buildDb(cap), {} as never);
  await svc.listActivities("org-1", { cursor, limit: 20 });
  return cap;
}

const CURSOR = encodeCursor({ sortValue: "2024-06-01T00:00:00.000Z", id: "10" });

describe("CollectionsService.listActivities — keyset", () => {
  it("sorts by created_at desc then id desc", async () => {
    const { orderBy } = await captureList(undefined);
    expect(orderBy).toHaveLength(2);
    expect(render(orderBy[0])).toContain('"created_at"');
    expect(render(orderBy[0])).toContain("desc");
    expect(render(orderBy[1])).toContain('"id"');
    expect(render(orderBy[1])).toContain("desc");
  });

  it("cursor adds tuple less-than on page 2", async () => {
    const { where } = await captureList(CURSOR);
    expect(render(where)).toContain("<");
  });

  it("no cursor predicate on page 1", async () => {
    expect(render((await captureList(undefined)).where)).not.toContain("<");
  });

  it("bite proof: old listActivities had no id tiebreaker in orderBy", () => {
    const oldSort = ['"fin_collection_activities"."created_at" desc'];
    expect(oldSort).toHaveLength(1);
  });
});
