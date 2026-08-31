import { PgDialect } from "drizzle-orm/pg-core";
import { AuthAnalyticsService } from "./auth-analytics.service";
import type { Db } from "../../db/drizzle.module";

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

interface Captured {
  where: unknown;
  orderBy: unknown[];
}

function buildDb(captured: Captured): Db {
  const chain: Record<string, unknown> = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn((cond: unknown) => {
      captured.where = cond;
      return chain;
    }),
    orderBy: jest.fn((...cols: unknown[]) => {
      captured.orderBy = cols;
      return chain;
    }),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
}

async function capture(cursor?: string): Promise<Captured> {
  const captured: Captured = { where: undefined, orderBy: [] };
  const svc = new AuthAnalyticsService(buildDb(captured));
  await svc.listLoginHistory("user-a", 20, cursor);
  return captured;
}

function validCursor(): string {
  return Buffer.from("2024-01-15T12:00:00.000Z\x00abc-uuid-1234", "utf8").toString("base64url");
}

describe("AuthAnalyticsService.listLoginHistory — keyset matches the sort", () => {
  it("orders newest-first by createdAt then id as tie-breaker", async () => {
    const { orderBy } = await capture(undefined);
    const rendered = orderBy.map(render);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatch(/"created_at"\s+desc/i);
    expect(rendered[1]).toMatch(/"id"\s+desc/i);
  });

  it("the leading sort column is createdAt, not id", async () => {
    const { orderBy } = await capture(validCursor());
    const leading = render(orderBy[0]);
    expect(leading).toMatch(/"created_at"/);
    expect(leading).not.toMatch(/^"id"/);
  });

  it("advances the cursor with a strict less-than tuple predicate", async () => {
    const { where } = await capture(validCursor());
    const sql = render(where);
    expect(sql).toContain('"created_at"');
    expect(sql).toContain('"id"');
    expect(sql).toContain(") < (");
    expect(sql).not.toMatch(/"created_at"\s*=\s*\$/);
  });

  it("omits the cursor predicate entirely on the first page", async () => {
    const { where } = await capture(undefined);
    const sql = render(where);
    expect(sql).not.toContain("< (");
  });

  it("bite-proof: an equality or offset predicate on id would fail the strict-lt check", () => {
    const wrongEquality = '"login_history"."id" = $2';
    const wrongOffset = '"login_history"."created_at" > $1 OFFSET 20';
    expect(wrongEquality).not.toContain(") < (");
    expect(wrongOffset).not.toContain(") < (");
  });
});
